import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { modeDefault, type Mode } from "./modes.ts";

export interface Rule {
  tool: string;
  pattern?: string;
}

export interface SessionRule extends Rule {
  prefix?: boolean;
}

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
const regexCache = new Map<string, RegExp>();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : String(value);
  } catch {
    return String(value);
  }
}

export function sanitizeRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rules: Rule[] = [];
  for (const item of value) {
    const rule = sanitizeSessionRule(item);
    if (rule) {
      rules.push({ tool: rule.tool, ...(rule.pattern === undefined ? {} : { pattern: rule.pattern }) });
    }
  }
  return rules;
}

export function sanitizeSessionRule(value: unknown): SessionRule | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const tool = value.tool;
  if (typeof tool !== "string" || tool.trim().length === 0) {
    return undefined;
  }
  const rule: SessionRule = { tool: tool.trim() };
  if (typeof value.pattern === "string" && value.pattern.trim().length > 0) {
    rule.pattern = value.pattern;
  }
  if (value.prefix === true) {
    rule.prefix = true;
  }
  return rule;
}

export function formatRule(rule: SessionRule): string {
  const parts = [`tool=${rule.tool}`];
  if (rule.pattern !== undefined) {
    parts.push(`pattern="${rule.pattern}"`);
  }
  if (rule.prefix === true) {
    parts.push("(prefix)");
  }
  return parts.join(" ");
}

function wildcardToRegExp(pattern: string): RegExp {
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

export function matchPattern(pattern: string, candidates: readonly string[]): boolean {
  if (WILDCARD.test(pattern)) {
    let regex = regexCache.get(pattern);
    if (!regex) {
      regex = wildcardToRegExp(pattern);
      regexCache.set(pattern, regex);
    }
    return candidates.some((candidate) => regex.test(candidate));
  }
  return candidates.some((candidate) => candidate.includes(pattern));
}

function matchesTool(ruleTool: string, toolName: string): boolean {
  if (ruleTool === "*") {
    return true;
  }
  if (WILDCARD.test(ruleTool)) {
    return matchPattern(ruleTool, [toolName]);
  }
  return ruleTool === toolName;
}

export function matchesRule(rule: SessionRule, toolName: string, candidates: readonly string[]): boolean {
  if (!matchesTool(rule.tool, toolName)) {
    return false;
  }
  const pattern = rule.pattern;
  if (pattern === undefined) {
    return true;
  }
  if (rule.prefix === true) {
    return candidates.some((candidate) => candidate === pattern || candidate.startsWith(`${pattern} `));
  }
  return matchPattern(pattern, candidates);
}

export function normalizeArgument(
  toolName: string,
  input: unknown,
  cfg: Pick<EngineConfig, "bashTools" | "pathTools">,
): string {
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (!isRecord(input)) {
    return safeStringify(input);
  }
  if (cfg.bashTools.includes(toolName)) {
    return typeof input.command === "string" ? input.command : safeStringify(input);
  }
  if (cfg.pathTools.includes(toolName)) {
    for (const key of PATH_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return safeStringify(input);
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function absolutePath(value: string, cwd: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function candidatesFor(
  toolName: string,
  argument: string,
  cwd: string,
  cfg: Pick<EngineConfig, "pathTools">,
): string[] {
  const candidates = new Set<string>();
  candidates.add(argument);
  if (argument.length > 0 && cfg.pathTools.includes(toolName) && !argument.includes("\n")) {
    const expanded = expandHome(argument);
    const absolute = absolutePath(argument, cwd);
    candidates.add(expanded);
    candidates.add(absolute);
    const relativePath = relative(cwd, absolute);
    if (relativePath.length > 0 && !relativePath.startsWith("..")) {
      candidates.add(relativePath);
    }
    candidates.add(basename(absolute));
  }
  return [...candidates];
}

export function splitBashCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (single) {
      current += ch;
      if (ch === "'") {
        single = false;
      }
      i += 1;
      continue;
    }
    if (double) {
      if (ch === "\\" && i + 1 < command.length) {
        current += ch + command[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      if (ch === '"') {
        double = false;
      }
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'") {
      single = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      double = true;
      current += ch;
      i += 1;
      continue;
    }
    if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
      segments.push(current);
      current = "";
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  segments.push(current);
  const trimmed = segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  return trimmed.length > 0 ? trimmed : [command.trim()];
}

export function commandProgram(segment: string): string {
  const tokens = segment.split(/\s+/).filter((token) => token.length > 0);
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    return token;
  }
  return tokens.length > 0 ? tokens[0] : "";
}

export function approvalRules(
  toolName: string,
  units: readonly string[],
  cwd: string,
  cfg: Pick<EngineConfig, "bashTools" | "pathTools">,
): SessionRule[] {
  if (cfg.bashTools.includes(toolName)) {
    const rules: SessionRule[] = [];
    const seen = new Set<string>();
    for (const unit of units) {
      const program = commandProgram(unit);
      if (program.length === 0 || seen.has(program)) {
        continue;
      }
      seen.add(program);
      rules.push({ tool: toolName, pattern: program, prefix: true });
    }
    return rules.length > 0 ? rules : [{ tool: toolName }];
  }
  if (cfg.pathTools.includes(toolName)) {
    const argument = units.length > 0 ? units[0] : "";
    if (argument.length === 0 || argument.includes("\n")) {
      return [{ tool: toolName }];
    }
    const parent = dirname(absolutePath(argument, cwd));
    const pattern = parent === "/" ? "/**" : `${parent}/**`;
    return [{ tool: toolName, pattern }];
  }
  return [{ tool: toolName }];
}

function evaluateUnit(
  toolName: string,
  candidates: readonly string[],
  cfg: EngineConfig,
  sessionRules: readonly SessionRule[],
): Decision {
  for (const rule of cfg.deny) {
    if (matchesRule(rule, toolName, candidates)) {
      return { action: "deny", reason: `deny rule ${formatRule(rule)}` };
    }
  }
  for (const rule of cfg.allow) {
    if (matchesRule(rule, toolName, candidates)) {
      return { action: "allow", reason: `allow rule ${formatRule(rule)}` };
    }
  }
  for (const rule of sessionRules) {
    if (matchesRule(rule, toolName, candidates)) {
      return { action: "allow", reason: `session approval ${formatRule(rule)}` };
    }
  }
  if (cfg.mode === "yolo") {
    return { action: "allow", reason: "yolo mode allows everything not denied" };
  }
  for (const rule of cfg.ask) {
    if (matchesRule(rule, toolName, candidates)) {
      return { action: "ask", reason: `ask rule ${formatRule(rule)}` };
    }
  }
  const fallback = modeDefault(cfg.mode, toolName, cfg.readTools, cfg.writeTools);
  return { action: fallback, reason: `${cfg.mode} mode default for ${toolName}` };
}

function evaluateBash(
  toolName: string,
  command: string,
  cfg: EngineConfig,
  sessionRules: readonly SessionRule[],
): Evaluation {
  const full = command.trim();
  for (const rule of cfg.deny) {
    if (matchesRule(rule, toolName, [full])) {
      return { action: "deny", reason: `deny rule ${formatRule(rule)}`, units: [full] };
    }
  }
  const segments = splitBashCommand(command);
  const pending: string[] = [];
  let reason = "";
  for (const segment of segments) {
    const decision = evaluateUnit(toolName, [segment], cfg, sessionRules);
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

export function evaluate(
  toolName: string,
  input: unknown,
  cwd: string,
  cfg: EngineConfig,
  sessionRules: readonly SessionRule[],
): Evaluation {
  const argument = normalizeArgument(toolName, input, cfg);
  if (cfg.bashTools.includes(toolName)) {
    return evaluateBash(toolName, argument, cfg, sessionRules);
  }
  const candidates = candidatesFor(toolName, argument, cwd, cfg);
  const decision = evaluateUnit(toolName, candidates, cfg, sessionRules);
  return { action: decision.action, reason: decision.reason, units: [argument] };
}
