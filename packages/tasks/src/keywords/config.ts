import { isLevel, levelIndex } from "./scan.ts";
import type { Matcher, ThinkingLevel } from "./scan.ts";

export interface KeywordsConfig {
  keywords: Record<string, unknown>;
  orchestrate: boolean;
  ultrawork: boolean;
  adaptive: boolean;
  adaptiveMin: ThinkingLevel;
  adaptiveMax: ThinkingLevel;
  restore: boolean;
  metMarker: string;
}

export interface SummaryState {
  matchers: readonly Matcher[];
  adaptive: boolean;
  current: ThinkingLevel | undefined;
  baseline: ThinkingLevel | undefined;
}

export class Config {
  static readonly defaults: KeywordsConfig = {
    keywords: {
      ultrathink: "xhigh",
      "think harder": "high",
      "think ultra": "high",
      quickthink: "low",
    },
    orchestrate: true,
    ultrawork: true,
    adaptive: false,
    adaptiveMin: "low",
    adaptiveMax: "high",
    restore: true,
    metMarker: "<goal-met/>",
  };

  readonly values: KeywordsConfig;

  constructor(layers: readonly unknown[]) {
    let merged: Record<string, unknown> = {
      ...Config.defaults,
      keywords: { ...Config.defaults.keywords },
    };

    for (const layer of layers) {

      if (Config.isRecord(layer)) {
        merged = Config.deepMerge(merged, layer);
      }
    }

    this.values = Config.coerce(merged);
  }

  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = result[key];

      if (Config.isRecord(current) && Config.isRecord(value)) {
        result[key] = Config.deepMerge(current, value);
      } else if (value !== undefined) {
        result[key] = value;
      }
    }

    return result;
  }

  static bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  static level(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
    return isLevel(value) ? value : fallback;
  }

  static coerce(merged: Record<string, unknown>): KeywordsConfig {
    const defaults = Config.defaults;
    let adaptiveMin = Config.level(merged.adaptiveMin, defaults.adaptiveMin);
    let adaptiveMax = Config.level(merged.adaptiveMax, defaults.adaptiveMax);

    if (levelIndex(adaptiveMin) > levelIndex(adaptiveMax)) {
      const swap = adaptiveMin;
      adaptiveMin = adaptiveMax;
      adaptiveMax = swap;
    }

    const marker =
      typeof merged.metMarker === "string" && merged.metMarker.trim()
        ? merged.metMarker.trim()
        : defaults.metMarker;

    return {
      keywords: Config.isRecord(merged.keywords) ? merged.keywords : { ...defaults.keywords },
      orchestrate: Config.bool(merged.orchestrate, defaults.orchestrate),
      ultrawork: Config.bool(merged.ultrawork, defaults.ultrawork),
      adaptive: Config.bool(merged.adaptive, defaults.adaptive),
      adaptiveMin,
      adaptiveMax,
      restore: Config.bool(merged.restore, defaults.restore),
      metMarker: marker,
    };
  }

  thinkingNote(target: ThinkingLevel, keywords: readonly string[]): string {
    const invoked = keywords.map(keyword => `"${keyword}"`).join(", ");

    if (target === "xhigh") {

      return `[${invoked} invoked: maximum reasoning effort was requested for this turn. Think as deeply and as long as needed before acting.]`;
    }

    if (target === "high") {

      return `[${invoked} invoked: heightened reasoning effort was requested for this turn. Reason carefully before acting.]`;
    }

    if (target === "medium") {

      return `[${invoked} invoked: reasoning effort for this turn was set to medium.]`;
    }

    return `[${invoked} invoked: minimal reasoning overhead was requested for this turn. Be quick and direct.]`;
  }

  orchestrateNote(taskAvailable: boolean): string {
    if (taskAvailable) {

      return "[orchestrate invoked: decompose this task into independent subtasks, delegate the parallelizable ones to the task tool, run them concurrently where safe, then integrate and verify the combined result.]";
    }

    return "[orchestrate invoked: decompose this task into clear, ordered subtasks and work through them systematically, verifying each before moving on.]";
  }

  ultraworkNote(marker: string): string {
    return `[ultrawork invoked: work autonomously until the task is fully complete. Do not pause for confirmation unless genuinely blocked. When everything is verifiably done, say so explicitly and include ${marker} in your final message so the goals extension can confirm completion.]`;
  }

  summary(state: SummaryState): string {
    const lines: string[] = ["Thinking keywords:"];

    if (state.matchers.length === 0) {
      lines.push("  (none configured)");
    } else {
      const ordered = [...state.matchers].sort((a, b) => levelIndex(b.level) - levelIndex(a.level));

      for (const matcher of ordered) {
        lines.push(`  ${matcher.keyword} -> ${matcher.level}`);
      }
    }

    lines.push(`Orchestrate keyword: ${this.values.orchestrate ? "on (orchestrate)" : "off"}`);
    lines.push(`Ultrawork keywords: ${this.values.ultrawork ? "on (ulw, ultrawork)" : "off"}`);
    lines.push(
      `Adaptive thinking: ${state.adaptive ? "on" : "off"} (bounds ${this.values.adaptiveMin}-${this.values.adaptiveMax}, config default ${this.values.adaptive ? "on" : "off"})`,
    );
    lines.push(`Restore baseline after turn: ${this.values.restore ? "on" : "off"}`);
    lines.push(`Current level: ${state.current ?? "unknown"}  Baseline: ${state.baseline ?? state.current ?? "unknown"}`);

    return lines.join("\n");
  }
}
