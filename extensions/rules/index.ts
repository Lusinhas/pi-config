import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type FormatFlags, type ParsedRule, type RuleError, discoverRules } from "./formats";
import { TouchTracker, matchGlob } from "./matcher";

interface RulesConfig {
  formats: FormatFlags;
  alwaysBudget: number;
  scopedBudget: number;
}

interface RulesState {
  trusted: boolean;
  rules: ParsedRule[];
  errors: RuleError[];
  lastInjected: Map<string, string>;
  lastActive: Set<string>;
  rounds: number;
}

const DEFAULTS: RulesConfig = {
  formats: { pi: true, claude: true, cursor: true, copilot: true, windsurf: true, cline: true },
  alwaysBudget: 8000,
  scopedBudget: 6000,
};

const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "absolute_path",
  "absolutePath",
  "file",
  "filename",
  "directory",
  "dir",
] as const;

const PATH_LIST_KEYS = ["paths", "files"] as const;

const SEARCH_LOCATIONS =
  ".pi/rules/*.md, .claude/rules/*.md, .cursor/rules/*.mdc, .github/copilot-instructions.md, .github/instructions/*.instructions.md, .windsurf/rules/*.md, .clinerules";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function coerceBudget(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function coerceFormats(value: unknown): FormatFlags {
  const flags: FormatFlags = { ...DEFAULTS.formats };
  if (isRecord(value)) {
    for (const key of Object.keys(flags) as (keyof FormatFlags)[]) {
      const candidate = value[key];
      if (typeof candidate === "boolean") flags[key] = candidate;
    }
  }
  return flags;
}

function loadConfig(): RulesConfig {
  let merged: Record<string, unknown> = {
    formats: { ...DEFAULTS.formats },
    alwaysBudget: DEFAULTS.alwaysBudget,
    scopedBudget: DEFAULTS.scopedBudget,
  };
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) merged = deepMerge(merged, parsed);
  } catch {
    merged = {
      formats: { ...DEFAULTS.formats },
      alwaysBudget: DEFAULTS.alwaysBudget,
      scopedBudget: DEFAULTS.scopedBudget,
    };
  }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "suite.json"));
  if (globalConfig && isRecord(globalConfig.rules)) merged = deepMerge(merged, globalConfig.rules);
  const projectConfig = readJson(join(process.cwd(), ".pi", "suite.json"));
  if (projectConfig && isRecord(projectConfig.rules)) merged = deepMerge(merged, projectConfig.rules);
  return {
    formats: coerceFormats(merged.formats),
    alwaysBudget: coerceBudget(merged.alwaysBudget, DEFAULTS.alwaysBudget),
    scopedBudget: coerceBudget(merged.scopedBudget, DEFAULTS.scopedBudget),
  };
}

export default function rules(pi: ExtensionAPI): void {
  const config = loadConfig();
  const tracker = new TouchTracker();
  const hashes = new Map<string, string>();
  const state: RulesState = {
    trusted: false,
    rules: [],
    errors: [],
    lastInjected: new Map<string, string>(),
    lastActive: new Set<string>(),
    rounds: 0,
  };

  const refresh = (cwd: string, trusted: boolean): void => {
    state.trusted = trusted;
    hashes.clear();
    if (!trusted) {
      state.rules = [];
      state.errors = [];
      return;
    }
    const result = discoverRules(cwd, config.formats);
    state.rules = result.rules;
    state.errors = result.errors;
    for (const rule of state.rules) {
      hashes.set(rule.path, createHash("sha256").update(rule.body, "utf8").digest("hex"));
    }
  };

  const renderHeader = (rule: ParsedRule): string =>
    rule.always
      ? `### Rule: ${rule.relPath} [${rule.source}, always]`
      : `### Rule: ${rule.relPath} [${rule.source}, paths: ${rule.scopes.join(" ")}]`;

  const fill = (
    group: ParsedRule[],
    budget: number,
    blocks: string[],
    nextInjected: Map<string, string>,
    nextActive: Set<string>,
  ): void => {
    let used = 0;
    for (const rule of group) {
      const hash = hashes.get(rule.path);
      if (hash === undefined) continue;
      if (state.lastInjected.get(rule.path) === hash) {
        nextInjected.set(rule.path, hash);
        nextActive.add(rule.path);
        continue;
      }
      const header = renderHeader(rule);
      let block = `${header}\n${rule.body}`;
      if (used + block.length > budget) {
        const remaining = budget - used;
        const overhead = header.length + 64;
        if (blocks.length > 0 || remaining <= overhead) continue;
        block = `${header}\n${rule.body.slice(0, remaining - overhead)}\n[rule truncated to fit budget]`;
      }
      blocks.push(block);
      used += block.length;
      nextInjected.set(rule.path, hash);
      nextActive.add(rule.path);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    let trusted = false;
    try {
      trusted = ctx.isProjectTrusted();
    } catch {
      trusted = false;
    }
    refresh(ctx.cwd, trusted);
    tracker.reset();
    state.lastInjected = new Map<string, string>();
    state.lastActive = new Set<string>();
    state.rounds = 0;
  });

  pi.on("resources_discover", (event, ctx) => {
    if (event.reason !== "reload") return undefined;
    let trusted = false;
    try {
      trusted = ctx.isProjectTrusted();
    } catch {
      trusted = false;
    }
    const cwd = typeof event.cwd === "string" && event.cwd !== "" ? event.cwd : ctx.cwd;
    refresh(cwd, trusted);
    return undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      const input: unknown = event.input;
      if (!isRecord(input)) return undefined;
      if (event.toolName === "bash") {
        const rawCwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
        const base = rawCwd !== "" ? resolve(ctx.cwd, rawCwd) : ctx.cwd;
        if (rawCwd !== "") tracker.touch(rawCwd, ctx.cwd, ctx.cwd);
        if (typeof input.command === "string") tracker.touchBashCommand(input.command, ctx.cwd, base);
        return undefined;
      }
      for (const key of PATH_KEYS) {
        const value = input[key];
        if (typeof value === "string") tracker.touch(value, ctx.cwd, ctx.cwd);
      }
      for (const key of PATH_LIST_KEYS) {
        const value = input[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === "string") tracker.touch(item, ctx.cwd, ctx.cwd);
          }
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  });

  pi.on("before_agent_start", () => {
    const touched = tracker.consume();
    const nextInjected = new Map<string, string>();
    const nextActive = new Set<string>();
    const alwaysBlocks: string[] = [];
    const scopedBlocks: string[] = [];
    const alwaysRules = state.rules.filter((rule) => rule.always);
    const scopedRules = state.rules.filter(
      (rule) =>
        !rule.always &&
        rule.scopes.length > 0 &&
        touched.some((path) => rule.scopes.some((glob) => matchGlob(glob, path))),
    );
    fill(alwaysRules, config.alwaysBudget, alwaysBlocks, nextInjected, nextActive);
    fill(scopedRules, config.scopedBudget, scopedBlocks, nextInjected, nextActive);
    state.lastInjected = nextInjected;
    state.lastActive = nextActive;
    state.rounds += 1;
    const blocks = [...alwaysBlocks, ...scopedBlocks];
    if (blocks.length === 0) return undefined;
    const content = `Project rules in effect. Each block names its source file; scoped rules apply when working on their listed paths.\n\n${blocks.join("\n\n")}`;
    return { message: { customType: "rulesinjection", content, display: false } };
  });

  pi.registerCommand("rules", {
    description: "List discovered path-scoped rules with source, scope, last-turn activity, and parse errors",
    handler: async (_args, ctx): Promise<void> => {
      if (!ctx.hasUI) return;
      if (!state.trusted) {
        ctx.ui.notify("Rules: project is not trusted; rule files are not loaded.", "warning");
        return;
      }
      if (state.rules.length === 0 && state.errors.length === 0) {
        ctx.ui.notify(`Rules: no rule files found. Searched: ${SEARCH_LOCATIONS}.`, "info");
        return;
      }
      const lines: string[] = [];
      const errorSuffix =
        state.errors.length > 0 ? `, ${state.errors.length} parse error${state.errors.length === 1 ? "" : "s"}` : "";
      const activity = state.rounds > 0 ? `${state.lastActive.size} active last turn` : "no turns yet";
      lines.push(`Rules: ${state.rules.length} discovered, ${activity}${errorSuffix}`);
      for (const rule of state.rules) {
        const status = state.rounds === 0 ? "pending" : state.lastActive.has(rule.path) ? "active" : "inactive";
        const scope = rule.always ? "always" : rule.scopes.length > 0 ? rule.scopes.join(", ") : "manual (no scope)";
        lines.push(`  [${status}] ${rule.source} ${rule.relPath} - ${scope}`);
      }
      if (state.errors.length > 0) {
        lines.push("Parse errors:");
        for (const error of state.errors) {
          lines.push(`  ${error.source} ${error.relPath}: ${error.message}`);
        }
      }
      const disabled = (Object.keys(config.formats) as (keyof FormatFlags)[]).filter((key) => !config.formats[key]);
      if (disabled.length > 0) lines.push(`Disabled formats: ${disabled.join(", ")}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
