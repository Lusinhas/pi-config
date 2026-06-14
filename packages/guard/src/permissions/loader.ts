import { isRecord, RuleSanitizer, type Rule } from "./text.ts";
import { Modes, type Mode } from "./modes.ts";

export type HeadlessPolicy = "allow" | "deny";

export type Risk = "safe" | "risky";

export interface JudgeConfig {
  enabled: boolean;
  model: string;
  maxRisk: Risk;
  timeoutMs: number;
  maxTokens: number;
}

export interface PermissionsConfig {
  mode: Mode;
  allow: Rule[];
  deny: Rule[];
  ask: Rule[];
  headless: HeadlessPolicy;
  readTools: string[];
  writeTools: string[];
  bashTools: string[];
  pathTools: string[];
  previewLength: number;
  subagentBridge: boolean;
  ideDiff: boolean;
  judge: JudgeConfig;
}

export class Loader {
  static readonly FALLBACK: PermissionsConfig = {
    mode: "ask",
    allow: [],
    deny: [],
    ask: [],
    headless: "deny",
    subagentBridge: true,
    ideDiff: true,
    readTools: ["read", "grep", "find", "ls", "artifact", "advisor", "ask", "todo", "astsearch", "history"],
    writeTools: ["write", "edit", "bash"],
    bashTools: ["bash"],
    pathTools: ["read", "write", "edit", "ls"],
    previewLength: 160,
    judge: {
      enabled: false,
      model: "anthropic/claude-haiku-4-5",
      maxRisk: "safe",
      timeoutMs: 20000,
      maxTokens: 200,
    },
  };

  static deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = merged[key];

      if (isRecord(current) && isRecord(value)) {
        merged[key] = Loader.deepMerge(current, value);
      } else if (value !== undefined) {
        merged[key] = value;
      }
    }

    return merged;
  }

  static stringArray(value: unknown, fallback: readonly string[]): string[] {
    if (!Array.isArray(value)) {
      return [...fallback];
    }

    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }

  static positiveInt(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }

    return fallback;
  }

  static normalizeJudge(value: unknown): JudgeConfig {
    const fallback = Loader.FALLBACK.judge;

    if (!isRecord(value)) {
      return { ...fallback };
    }

    return {
      enabled: value.enabled === true,
      model: typeof value.model === "string" && value.model.includes("/") ? value.model : fallback.model,
      maxRisk: value.maxRisk === "risky" ? "risky" : "safe",
      timeoutMs: Loader.positiveInt(value.timeoutMs, fallback.timeoutMs),
      maxTokens: Loader.positiveInt(value.maxTokens, fallback.maxTokens),
    };
  }

  static normalizeConfig(raw: Record<string, unknown>): PermissionsConfig {
    return {
      mode: Modes.is(raw.mode) ? raw.mode : Loader.FALLBACK.mode,
      allow: RuleSanitizer.rules(raw.allow),
      deny: RuleSanitizer.rules(raw.deny),
      ask: RuleSanitizer.rules(raw.ask),
      headless: raw.headless === "allow" ? "allow" : "deny",
      readTools: Loader.stringArray(raw.readTools, Loader.FALLBACK.readTools),
      writeTools: Loader.stringArray(raw.writeTools, Loader.FALLBACK.writeTools),
      bashTools: Loader.stringArray(raw.bashTools, Loader.FALLBACK.bashTools),
      pathTools: Loader.stringArray(raw.pathTools, Loader.FALLBACK.pathTools),
      previewLength: Loader.positiveInt(raw.previewLength, Loader.FALLBACK.previewLength),
      subagentBridge: raw.subagentBridge !== false,
      ideDiff: raw.ideDiff !== false,
      judge: Loader.normalizeJudge(raw.judge),
    };
  }

  static fromRaw(
    shipped: Record<string, unknown> | null,
    global: Record<string, unknown> | null,
    project: Record<string, unknown> | null,
  ): PermissionsConfig {
    let merged: Record<string, unknown> = isRecord(shipped) ? { ...shipped } : {};

    if (global !== null && isRecord(global.permissions)) {
      merged = Loader.deepMerge(merged, global.permissions);
    }

    if (project !== null && isRecord(project.permissions)) {
      merged = Loader.deepMerge(merged, project.permissions);
    }

    return Loader.normalizeConfig(merged);
  }
}
