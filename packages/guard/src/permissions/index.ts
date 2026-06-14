import { dirname } from "node:path";
import { Modes, type Mode } from "./modes.ts";
import { BashParser } from "./parsing.ts";
import { PathResolver } from "./path.ts";
import { isRecord, RuleText, type Rule, type SessionRule } from "./text.ts";

export type Action = "allow" | "deny" | "ask";

export interface Decision {
  action: Action;
  reason: string;
}

export interface Evaluation extends Decision {
  units: string[];
}

export interface EngineConfig {
  mode: Mode;
  allow: Rule[];
  deny: Rule[];
  ask: Rule[];
  readTools: string[];
  writeTools: string[];
  bashTools: string[];
  pathTools: string[];
}

const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "directory", "dir"];
const WILDCARD = /[*?]/;
const REGEX_CACHE_LIMIT = 512;

class RegexCache {
  private readonly entries = new Map<string, RegExp>();

  constructor(private readonly limit: number) {}

  get(pattern: string): RegExp {
    const existing = this.entries.get(pattern);

    if (existing) {
      this.entries.delete(pattern);
      this.entries.set(pattern, existing);

      return existing;
    }

    const compiled = RegexCache.compile(pattern);

    this.entries.set(pattern, compiled);

    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;

      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }

    return compiled;
  }

  get size(): number {
    return this.entries.size;
  }

  private static compile(pattern: string): RegExp {
    let source = "";
    let i = 0;

    while (i < pattern.length) {
      const ch = pattern[i];

      if (ch === "*") {
        if (pattern[i + 1] === "*") {
          source += "[\\s\\S]*";
          i += 2;
        } else {
          source += "[^/]*";
          i += 1;
        }
      } else if (ch === "?") {
        source += "[^/]";
        i += 1;
      } else {
        source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        i += 1;
      }
    }

    return new RegExp(`^${source}$`);
  }
}

export class RuleEngine {
  private readonly cache = new RegexCache(REGEX_CACHE_LIMIT);

  constructor(
    private readonly config: EngineConfig,
    private sessionRules: readonly SessionRule[],
  ) {}

  withMode(mode: Mode): RuleEngine {
    this.config.mode = mode;

    return this;
  }

  withSessionRules(sessionRules: readonly SessionRule[]): RuleEngine {
    this.sessionRules = sessionRules;

    return this;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  matchPattern(pattern: string, candidates: readonly string[]): boolean {
    if (WILDCARD.test(pattern)) {
      const regex = this.cache.get(pattern);

      return candidates.some((candidate) => regex.test(candidate));
    }

    return candidates.some((candidate) => candidate.includes(pattern));
  }

  private matchesTool(ruleTool: string, toolName: string): boolean {
    if (ruleTool === "*") {
      return true;
    }

    if (WILDCARD.test(ruleTool)) {
      return this.matchPattern(ruleTool, [toolName]);
    }

    return ruleTool === toolName;
  }

  matchesRule(rule: SessionRule, toolName: string, candidates: readonly string[]): boolean {
    if (!this.matchesTool(rule.tool, toolName)) {
      return false;
    }

    const pattern = rule.pattern;

    if (pattern === undefined) {
      return true;
    }

    if (rule.prefix === true) {
      return candidates.some((candidate) => candidate === pattern || candidate.startsWith(`${pattern} `));
    }

    return this.matchPattern(pattern, candidates);
  }

  normalizeArgument(toolName: string, input: unknown): string {
    if (input === undefined || input === null) {
      return "";
    }

    if (typeof input === "string") {
      return input;
    }

    if (!isRecord(input)) {
      return RuleText.safeStringify(input);
    }

    if (this.config.bashTools.includes(toolName)) {
      return typeof input.command === "string" ? input.command : RuleText.safeStringify(input);
    }

    if (this.config.pathTools.includes(toolName)) {
      for (const key of PATH_KEYS) {
        const value = input[key];

        if (typeof value === "string" && value.length > 0) {
          return value;
        }
      }
    }

    return RuleText.safeStringify(input);
  }

  approvalRules(toolName: string, units: readonly string[], cwd: string): SessionRule[] {
    if (this.config.bashTools.includes(toolName)) {
      const rules: SessionRule[] = [];
      const seen = new Set<string>();

      for (const unit of units) {
        const program = BashParser.program(unit);

        if (program.length === 0 || seen.has(program)) {
          continue;
        }

        seen.add(program);
        rules.push({ tool: toolName, pattern: program, prefix: true });
      }

      return rules.length > 0 ? rules : [{ tool: toolName }];
    }

    if (this.config.pathTools.includes(toolName)) {
      const argument = units.length > 0 ? units[0] : "";

      if (argument.length === 0 || argument.includes("\n")) {
        return [{ tool: toolName }];
      }

      const parent = dirname(PathResolver.absolute(argument, cwd));
      const pattern = parent === "/" ? "/**" : `${parent}/**`;

      return [{ tool: toolName, pattern }];
    }

    return [{ tool: toolName }];
  }

  private evaluateUnit(toolName: string, candidates: readonly string[]): Decision {
    for (const rule of this.config.deny) {
      if (this.matchesRule(rule, toolName, candidates)) {
        return { action: "deny", reason: `deny rule ${RuleText.format(rule)}` };
      }
    }

    for (const rule of this.config.allow) {
      if (this.matchesRule(rule, toolName, candidates)) {
        return { action: "allow", reason: `allow rule ${RuleText.format(rule)}` };
      }
    }

    if (this.config.mode !== "ask") {
      for (const rule of this.sessionRules) {
        if (this.matchesRule(rule, toolName, candidates)) {
          return { action: "allow", reason: `session approval ${RuleText.format(rule)}` };
        }
      }
    }

    if (this.config.mode === "yolo") {
      return { action: "allow", reason: "yolo mode allows everything not denied" };
    }

    for (const rule of this.config.ask) {
      if (this.matchesRule(rule, toolName, candidates)) {
        return { action: "ask", reason: `ask rule ${RuleText.format(rule)}` };
      }
    }

    const fallback = Modes.defaultAction(this.config.mode, toolName, this.config.readTools, this.config.writeTools);

    return { action: fallback, reason: `${this.config.mode} mode default for ${toolName}` };
  }

  private evaluateBash(toolName: string, command: string): Evaluation {
    const full = command.trim();

    for (const rule of this.config.deny) {
      if (this.matchesRule(rule, toolName, [full])) {
        return { action: "deny", reason: `deny rule ${RuleText.format(rule)}`, units: [full] };
      }
    }

    const segments = BashParser.split(command);
    const pending: string[] = [];
    let reason = "";

    for (const segment of segments) {
      const decision = this.evaluateUnit(toolName, [segment]);

      if (decision.action === "deny") {
        return { action: "deny", reason: `${decision.reason} on segment "${segment}"`, units: [segment] };
      }

      if (decision.action === "ask") {
        pending.push(segment);

        if (reason.length === 0) {
          reason = decision.reason;
        }
      }
    }

    if (pending.length === 0) {
      return {
        action: "allow",
        reason: segments.length > 1 ? "all command segments allowed" : "command allowed",
        units: segments,
      };
    }

    return { action: "ask", reason, units: pending };
  }

  evaluate(toolName: string, input: unknown, cwd: string): Evaluation {
    const argument = this.normalizeArgument(toolName, input);

    if (this.config.bashTools.includes(toolName)) {
      return this.evaluateBash(toolName, argument);
    }

    const candidates = PathResolver.candidates(toolName, argument, cwd, this.config.pathTools);
    const decision = this.evaluateUnit(toolName, candidates);

    return { action: decision.action, reason: decision.reason, units: [argument] };
  }
}
