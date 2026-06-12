import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, nudgeLevel } from "./adaptive";
import { buildMatchers, isLevel, levelIndex, scanThinking, stripMatches, wordRegex } from "./scan";
import type { Matcher, ThinkingLevel } from "./scan";

interface KeywordsConfig {
  keywords: Record<string, unknown>;
  orchestrate: boolean;
  ultrawork: boolean;
  adaptive: boolean;
  adaptiveMin: ThinkingLevel;
  adaptiveMax: ThinkingLevel;
  restore: boolean;
  metMarker: string;
}

const DEFAULTS: KeywordsConfig = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(source: string | URL): unknown {
  try {
    return JSON.parse(readFileSync(source, "utf8"));
  } catch {
    return undefined;
  }
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMerge(current, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function level(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return isLevel(value) ? value : fallback;
}

function loadConfig(): KeywordsConfig {
  let merged: Record<string, unknown> = {
    ...DEFAULTS,
    keywords: { ...DEFAULTS.keywords },
  };
  const shipped = readJson(new URL("./config.json", import.meta.url));
  if (isRecord(shipped)) {
    merged = deepMerge(merged, shipped);
  }
  const overridePaths = [join(homedir(), ".pi", "agent", "suite.json"), join(process.cwd(), ".pi", "suite.json")];
  for (const path of overridePaths) {
    const parsed = readJson(path);
    if (isRecord(parsed) && isRecord(parsed.keywords)) {
      merged = deepMerge(merged, parsed.keywords);
    }
  }
  let adaptiveMin = level(merged.adaptiveMin, DEFAULTS.adaptiveMin);
  let adaptiveMax = level(merged.adaptiveMax, DEFAULTS.adaptiveMax);
  if (levelIndex(adaptiveMin) > levelIndex(adaptiveMax)) {
    const swap = adaptiveMin;
    adaptiveMin = adaptiveMax;
    adaptiveMax = swap;
  }
  return {
    keywords: isRecord(merged.keywords) ? merged.keywords : { ...DEFAULTS.keywords },
    orchestrate: bool(merged.orchestrate, DEFAULTS.orchestrate),
    ultrawork: bool(merged.ultrawork, DEFAULTS.ultrawork),
    adaptive: bool(merged.adaptive, DEFAULTS.adaptive),
    adaptiveMin,
    adaptiveMax,
    restore: bool(merged.restore, DEFAULTS.restore),
    metMarker: typeof merged.metMarker === "string" && merged.metMarker.trim() ? merged.metMarker.trim() : DEFAULTS.metMarker,
  };
}

function thinkingNote(target: ThinkingLevel, keywords: readonly string[]): string {
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

function orchestrateNote(taskAvailable: boolean): string {
  if (taskAvailable) {
    return "[orchestrate invoked: decompose this task into independent subtasks, delegate the parallelizable ones to the task tool, run them concurrently where safe, then integrate and verify the combined result.]";
  }
  return "[orchestrate invoked: decompose this task into clear, ordered subtasks and work through them systematically, verifying each before moving on.]";
}

function ultraworkNote(marker: string): string {
  return `[ultrawork invoked: work autonomously until the task is fully complete. Do not pause for confirmation unless genuinely blocked. When everything is verifiably done, say so explicitly and include ${marker} in your final message so the goals extension can confirm completion.]`;
}

export default function keywords(pi: ExtensionAPI): void {
  const config = loadConfig();
  const matchers: Matcher[] = buildMatchers(config.keywords);
  const orchestrateRegex = wordRegex(["orchestrate"]);
  const ultraworkRegex = wordRegex(["ulw", "ultrawork"]);
  let adaptive = config.adaptive;
  let baseline: ThinkingLevel | undefined;
  let pendingRestore: ThinkingLevel | undefined;
  let userSelected = false;
  const selfQueue: ThinkingLevel[] = [];

  const notify = (ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error"): void => {
    if (!ctx.hasUI) {
      return;
    }
    try {
      ctx.ui.notify(message, kind);
    } catch {
      return;
    }
  };

  const currentLevel = (): ThinkingLevel | undefined => {
    try {
      const value = pi.getThinkingLevel();
      return isLevel(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const applyLevel = (target: ThinkingLevel): boolean => {
    if (selfQueue.length >= 4) {
      selfQueue.shift();
    }
    selfQueue.push(target);
    try {
      pi.setThinkingLevel(target);
      return true;
    } catch {
      const index = selfQueue.lastIndexOf(target);
      if (index >= 0) {
        selfQueue.splice(index, 1);
      }
      return false;
    }
  };

  const taskToolAvailable = (): boolean => {
    try {
      return pi.getActiveTools().includes("task");
    } catch {
      return false;
    }
  };

  const summary = (): string => {
    const lines: string[] = ["Thinking keywords:"];
    if (matchers.length === 0) {
      lines.push("  (none configured)");
    } else {
      const ordered = [...matchers].sort((a, b) => levelIndex(b.level) - levelIndex(a.level));
      for (const matcher of ordered) {
        lines.push(`  ${matcher.keyword} -> ${matcher.level}`);
      }
    }
    lines.push(`Orchestrate keyword: ${config.orchestrate ? "on (orchestrate)" : "off"}`);
    lines.push(`Ultrawork keywords: ${config.ultrawork ? "on (ulw, ultrawork)" : "off"}`);
    lines.push(`Adaptive thinking: ${adaptive ? "on" : "off"} (bounds ${config.adaptiveMin}-${config.adaptiveMax}, config default ${config.adaptive ? "on" : "off"})`);
    lines.push(`Restore baseline after turn: ${config.restore ? "on" : "off"}`);
    const current = currentLevel();
    lines.push(`Current level: ${current ?? "unknown"}  Baseline: ${baseline ?? current ?? "unknown"}`);
    return lines.join("\n");
  };

  pi.on("session_start", () => {
    baseline = currentLevel();
    pendingRestore = undefined;
    userSelected = false;
    selfQueue.length = 0;
  });

  pi.on("thinking_level_select", (event: { level?: unknown; previousLevel?: unknown }) => {
    const selected = isLevel(event.level) ? event.level : undefined;
    if (selected && selfQueue.length > 0 && selfQueue[0] === selected) {
      selfQueue.shift();
      return;
    }
    selfQueue.length = 0;
    if (selected) {
      baseline = selected;
      userSelected = true;
      pendingRestore = undefined;
    }
  });

  pi.on("input", (event: { text?: unknown; source?: unknown }) => {
    if (event.source !== "interactive") {
      return { action: "continue" as const };
    }
    const original = typeof event.text === "string" ? event.text : "";
    if (!original.trim() || /^\s*\/\S/.test(original)) {
      return { action: "continue" as const };
    }
    const explicit = userSelected;
    userSelected = false;
    const scan = scanThinking(original, matchers);
    let text = scan.text;
    const notes: string[] = [];
    if (scan.level !== undefined) {
      const before = currentLevel();
      if (baseline === undefined) {
        baseline = before;
      }
      if (before !== scan.level) {
        const applied = applyLevel(scan.level);
        if (applied && config.restore && before !== undefined && pendingRestore === undefined) {
          pendingRestore = before;
        }
      }
      notes.push(thinkingNote(scan.level, scan.matched));
    }
    if (config.orchestrate && orchestrateRegex) {
      const result = stripMatches(text, orchestrateRegex);
      if (result.count > 0) {
        text = result.text;
        notes.push(orchestrateNote(taskToolAvailable()));
      }
    }
    if (config.ultrawork && ultraworkRegex) {
      const result = stripMatches(text, ultraworkRegex);
      if (result.count > 0) {
        text = result.text;
        notes.push(ultraworkNote(config.metMarker));
      }
    }
    if (notes.length === 0) {
      if (adaptive && !explicit) {
        const from = baseline ?? currentLevel();
        const direction = classify(original);
        if (from !== undefined && direction !== "none") {
          const target = nudgeLevel(from, direction, config.adaptiveMin, config.adaptiveMax);
          const before = currentLevel();
          if (target !== undefined && target !== before) {
            const applied = applyLevel(target);
            if (applied && config.restore && before !== undefined && pendingRestore === undefined) {
              pendingRestore = before;
            }
          }
        }
      }
      return { action: "continue" as const };
    }
    const body = text.trim();
    return { action: "transform" as const, text: body ? `${body}\n\n${notes.join("\n")}` : notes.join("\n") };
  });

  pi.on("agent_end", () => {
    if (pendingRestore === undefined) {
      return;
    }
    const target = pendingRestore;
    pendingRestore = undefined;
    if (!config.restore || currentLevel() === target) {
      return;
    }
    applyLevel(target);
  });

  pi.registerCommand("keywords", {
    description: "List magic keywords and adaptive thinking state, or toggle adaptive (/keywords adaptive [on|off])",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      if (input === "adaptive" || input === "adaptive on" || input === "adaptive off") {
        adaptive = input === "adaptive" ? !adaptive : input.endsWith(" on");
        notify(
          ctx,
          `Adaptive thinking ${adaptive ? "enabled" : "disabled"} (bounds ${config.adaptiveMin}-${config.adaptiveMax}). Persist via the keywords.adaptive key in suite.json.`,
          "info",
        );
        return;
      }
      if (input) {
        notify(ctx, "Usage: /keywords to list state, /keywords adaptive [on|off] to toggle adaptive thinking.", "error");
        return;
      }
      notify(ctx, summary(), "info");
    },
    getArgumentCompletions: (prefix: string) => {
      const options = ["adaptive", "adaptive on", "adaptive off"];
      const filtered = options.filter(option => option.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered.map(option => ({ value: option, label: option })) : null;
    },
  });
}
