import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { judgeGoal } from "./judge";
import type { GoalVerdict, JudgeRegistry } from "./judge";
import { LoopRunner, formatInterval, parseInterval } from "./loop";
import type { LoopSpec } from "./loop";

interface GoalsConfig {
  judgeModel: string;
  judgeTimeoutMs: number;
  judgeMaxChars: number;
  metMarker: string;
  maxIterations: number;
  enforceTodos: boolean;
  loopMinIntervalMs: number;
  statusMaxChars: number;
}

interface GoalState {
  condition: string;
  iterations: number;
  startedAt: number;
}

interface TodoSnapshot {
  open: number;
  items: unknown[];
}

const GOAL_ENTRY = "goals:goal";
const LOOP_ENTRY = "goals:loop";

const DEFAULTS: GoalsConfig = {
  judgeModel: "anthropic/claude-haiku-4-5",
  judgeTimeoutMs: 30000,
  judgeMaxChars: 8000,
  metMarker: "<goal-met/>",
  maxIterations: 25,
  enforceTodos: false,
  loopMinIntervalMs: 5000,
  statusMaxChars: 48,
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

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function loadConfig(): GoalsConfig {
  let merged: Record<string, unknown> = { ...DEFAULTS };
  const shipped = readJson(new URL("./config.json", import.meta.url));
  if (isRecord(shipped)) {
    merged = deepMerge(merged, shipped);
  }
  const overridePaths = [join(homedir(), ".pi", "agent", "suite.json"), join(process.cwd(), ".pi", "suite.json")];
  for (const path of overridePaths) {
    const parsed = readJson(path);
    if (isRecord(parsed) && isRecord(parsed.goals)) {
      merged = deepMerge(merged, parsed.goals);
    }
  }
  return {
    judgeModel: typeof merged.judgeModel === "string" && merged.judgeModel.trim() ? merged.judgeModel.trim() : DEFAULTS.judgeModel,
    judgeTimeoutMs: positive(merged.judgeTimeoutMs, DEFAULTS.judgeTimeoutMs),
    judgeMaxChars: Math.floor(positive(merged.judgeMaxChars, DEFAULTS.judgeMaxChars)),
    metMarker: typeof merged.metMarker === "string" && merged.metMarker ? merged.metMarker : DEFAULTS.metMarker,
    maxIterations: Math.floor(positive(merged.maxIterations, DEFAULTS.maxIterations)),
    enforceTodos: typeof merged.enforceTodos === "boolean" ? merged.enforceTodos : DEFAULTS.enforceTodos,
    loopMinIntervalMs: positive(merged.loopMinIntervalMs, DEFAULTS.loopMinIntervalMs),
    statusMaxChars: Math.floor(positive(merged.statusMaxChars, DEFAULTS.statusMaxChars)),
  };
}

function lastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    const content = message.content;
    if (typeof content === "string") {
      if (content.trim()) {
        return content;
      }
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    const text = parts.join("\n");
    if (text.trim()) {
      return text;
    }
  }
  return "";
}

export default function goals(pi: ExtensionAPI): void {
  const config = loadConfig();
  let goal: GoalState | undefined;
  let judging = false;
  let judgeAbort: AbortController | undefined;
  let todos: TodoSnapshot | undefined;
  let lastCtx: ExtensionContext | undefined;

  const abortJudge = (): void => {
    if (judgeAbort) {
      judgeAbort.abort();
      judgeAbort = undefined;
    }
  };

  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void => {
    if (!ctx.hasUI) {
      return;
    }
    try {
      ctx.ui.notify(message, level);
    } catch {
      return;
    }
  };

  const clipLine = (text: string): string => {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= config.statusMaxChars) {
      return flat;
    }
    return `${flat.slice(0, Math.max(1, config.statusMaxChars - 1))}…`;
  };

  const persistGoal = (): void => {
    try {
      if (goal) {
        pi.appendEntry(GOAL_ENTRY, {
          active: true,
          condition: goal.condition,
          iterations: goal.iterations,
          startedAt: goal.startedAt,
        });
      } else {
        pi.appendEntry(GOAL_ENTRY, { active: false });
      }
    } catch {
      return;
    }
  };

  const loop = new LoopRunner({
    send: (prompt: string): void => {
      pi.sendUserMessage(prompt);
    },
    isIdle: (): boolean => {
      const ctx = lastCtx;
      if (!ctx) {
        return false;
      }
      try {
        return ctx.isIdle() && !ctx.hasPendingMessages();
      } catch {
        return false;
      }
    },
    persist: (active: boolean, spec?: LoopSpec): void => {
      try {
        if (active && spec) {
          pi.appendEntry(LOOP_ENTRY, {
            active: true,
            intervalMs: spec.intervalMs,
            intervalLabel: spec.intervalLabel,
            prompt: spec.prompt,
            startedAt: spec.startedAt,
          });
        } else {
          pi.appendEntry(LOOP_ENTRY, { active: false });
        }
      } catch {
        return;
      }
    },
  });

  const updateStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) {
      return;
    }
    const parts: string[] = [];
    if (goal) {
      parts.push(`goal ${goal.iterations}/${config.maxIterations}: ${clipLine(goal.condition)}`);
    }
    const spec = loop.spec;
    if (spec) {
      parts.push(`loop ${spec.intervalLabel}: ${clipLine(spec.prompt)}`);
    }
    try {
      ctx.ui.setStatus("goals", parts.length > 0 ? parts.join("  ") : undefined);
    } catch {
      return;
    }
  };

  const clearGoal = (ctx: ExtensionContext): void => {
    abortJudge();
    goal = undefined;
    persistGoal();
    updateStatus(ctx);
  };

  const openTodoLabels = (): string[] => {
    if (!todos || todos.open <= 0) {
      return [];
    }
    const labels: string[] = [];
    for (const item of todos.items) {
      if (typeof item === "string") {
        if (item.trim()) {
          labels.push(item.trim());
        }
        continue;
      }
      if (!isRecord(item)) {
        continue;
      }
      if (item.done === true || item.completed === true) {
        continue;
      }
      if (typeof item.status === "string" && ["done", "completed", "cancelled", "canceled"].includes(item.status)) {
        continue;
      }
      const label = [item.text, item.title, item.content, item.label, item.description].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      labels.push(label ? label.trim() : JSON.stringify(item));
    }
    if (labels.length === 0) {
      labels.push(`${todos.open} open todo${todos.open === 1 ? "" : "s"}`);
    }
    return labels;
  };

  const buildNudge = (state: GoalState, verdict: GoalVerdict, openItems: string[]): string => {
    const lines: string[] = [
      "[goal] The completion condition is not yet met.",
      `Condition: ${state.condition}`,
      `Judge (${verdict.source}): ${verdict.reason}`,
    ];
    if (openItems.length > 0) {
      lines.push("Open todos:");
      const shown = openItems.slice(0, 20);
      for (const item of shown) {
        lines.push(`- ${item}`);
      }
      if (openItems.length > shown.length) {
        lines.push(`- …and ${openItems.length - shown.length} more`);
      }
    }
    lines.push(`Continuation ${state.iterations}/${config.maxIterations}.`);
    lines.push(
      `Keep working toward the condition. When it is fully satisfied, state that clearly and include ${config.metMarker} in your final message. If it is impossible or you are blocked, say so explicitly instead of repeating the same approach.`,
    );
    return lines.join("\n");
  };

  const statusText = (): string => {
    const lines: string[] = [];
    if (goal) {
      lines.push(`Goal: ${goal.condition}`);
      lines.push(`Continuations: ${goal.iterations}/${config.maxIterations}`);
      lines.push(`Judge model: ${config.judgeModel} (fallback marker: ${config.metMarker})`);
      lines.push(`Todo enforcement: ${config.enforceTodos ? "on" : "off"}`);
      if (config.enforceTodos && todos) {
        lines.push(`Open todos: ${todos.open}`);
      }
    } else {
      lines.push("No active goal.");
    }
    const spec = loop.spec;
    if (spec) {
      lines.push(`Loop: every ${spec.intervalLabel} — ${spec.prompt} (${loop.ticks} sent, ${loop.skipped} skipped)`);
    } else {
      lines.push("No active loop.");
    }
    return lines.join("\n");
  };

  const restore = (ctx: ExtensionContext): void => {
    abortJudge();
    loop.stop(false);
    goal = undefined;
    let goalData: Record<string, unknown> | undefined;
    let loopData: Record<string, unknown> | undefined;
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (!isRecord(entry) || entry.type !== "custom") {
          continue;
        }
        if (entry.customType === GOAL_ENTRY && isRecord(entry.data)) {
          goalData = entry.data;
        } else if (entry.customType === LOOP_ENTRY && isRecord(entry.data)) {
          loopData = entry.data;
        }
      }
    } catch {
      goalData = undefined;
      loopData = undefined;
    }
    if (goalData && goalData.active === true && typeof goalData.condition === "string" && goalData.condition.trim()) {
      goal = {
        condition: goalData.condition,
        iterations:
          typeof goalData.iterations === "number" && Number.isFinite(goalData.iterations)
            ? Math.max(0, Math.floor(goalData.iterations))
            : 0,
        startedAt: typeof goalData.startedAt === "number" ? goalData.startedAt : Date.now(),
      };
    }
    if (
      loopData &&
      loopData.active === true &&
      typeof loopData.prompt === "string" &&
      loopData.prompt.trim() &&
      typeof loopData.intervalMs === "number" &&
      Number.isFinite(loopData.intervalMs) &&
      loopData.intervalMs > 0
    ) {
      const intervalMs = Math.max(config.loopMinIntervalMs, Math.round(loopData.intervalMs));
      loop.start(
        {
          intervalMs,
          intervalLabel:
            typeof loopData.intervalLabel === "string" && loopData.intervalLabel
              ? loopData.intervalLabel
              : formatInterval(intervalMs),
          prompt: loopData.prompt,
          startedAt: typeof loopData.startedAt === "number" ? loopData.startedAt : Date.now(),
        },
        false,
      );
    }
    updateStatus(ctx);
  };

  pi.events.on("piconfig:todos", (payload: unknown) => {
    if (!isRecord(payload)) {
      return;
    }
    const open = typeof payload.open === "number" && Number.isFinite(payload.open) ? Math.max(0, payload.open) : 0;
    const items = Array.isArray(payload.items) ? payload.items : [];
    todos = { open, items };
  });

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    restore(ctx);
  });

  pi.on("session_shutdown", () => {
    abortJudge();
    loop.stop(false);
  });

  pi.on("agent_end", async (event, ctx) => {
    lastCtx = ctx;
    if (!goal || judging) {
      return;
    }
    const state = goal;
    judging = true;
    const controller = new AbortController();
    judgeAbort = controller;
    try {
      const lastText = lastAssistantText(Array.isArray(event.messages) ? event.messages : []);
      const openItems = config.enforceTodos ? openTodoLabels() : [];
      let verdict: GoalVerdict;
      if (openItems.length > 0) {
        verdict = {
          status: "unmet",
          reason: openItems.length === 1 ? "1 open todo remains" : `${openItems.length} open todos remain`,
          source: "todos",
        };
      } else {
        verdict = await judgeGoal({
          condition: state.condition,
          lastText,
          modelRef: config.judgeModel,
          timeoutMs: config.judgeTimeoutMs,
          maxChars: config.judgeMaxChars,
          metMarker: config.metMarker,
          registry: ctx.modelRegistry as unknown as JudgeRegistry,
          signal: controller.signal,
        });
      }
      if (goal !== state || controller.signal.aborted) {
        return;
      }
      if (verdict.status === "met") {
        notify(ctx, `Goal met: ${verdict.reason}`, "info");
        clearGoal(ctx);
        return;
      }
      if (verdict.status === "blocked") {
        notify(ctx, `Goal blocked: ${verdict.reason}`, "warning");
        clearGoal(ctx);
        return;
      }
      if (state.iterations >= config.maxIterations) {
        notify(ctx, `Goal stopped after ${config.maxIterations} continuations without being met: ${state.condition}`, "warning");
        clearGoal(ctx);
        return;
      }
      state.iterations += 1;
      persistGoal();
      updateStatus(ctx);
      pi.sendUserMessage(buildNudge(state, verdict, openItems), { deliverAs: "followUp" });
    } finally {
      judging = false;
      if (judgeAbort === controller) {
        judgeAbort = undefined;
      }
    }
  });

  pi.registerCommand("goal", {
    description: "Arm a completion condition judged after every agent run (/goal <condition> | status | off)",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const input = (args ?? "").trim();
      if (!input || input.toLowerCase() === "status") {
        notify(ctx, statusText(), "info");
        return;
      }
      if (input.toLowerCase() === "off") {
        const hadGoal = goal !== undefined;
        clearGoal(ctx);
        notify(ctx, hadGoal ? "Goal cleared." : "No active goal.", "info");
        return;
      }
      abortJudge();
      const replaced = goal !== undefined;
      goal = { condition: input, iterations: 0, startedAt: Date.now() };
      persistGoal();
      updateStatus(ctx);
      notify(
        ctx,
        `${replaced ? "Goal replaced" : "Goal armed"}: ${input}\nJudged by ${config.judgeModel} after each agent run, capped at ${config.maxIterations} continuations. Use /goal off to stop.`,
        "info",
      );
    },
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const options: AutocompleteItem[] = [
        { value: "status", label: "status", description: "Show goal and loop state" },
        { value: "off", label: "off", description: "Clear the active goal" },
      ];
      const filtered = options.filter(option => option.value.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered : null;
    },
  });

  pi.registerCommand("loop", {
    description: "Re-send a prompt on an interval while the session is idle (/loop <interval> <prompt> | off)",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const usage = "Usage: /loop <interval> <prompt> with intervals like 30s, 5m, 1h, 90, 1h30m — or /loop off";
      const input = (args ?? "").trim();
      if (!input) {
        const spec = loop.spec;
        notify(ctx, spec ? `Loop active: every ${spec.intervalLabel} — ${spec.prompt}\n${usage}` : `No active loop.\n${usage}`, "info");
        return;
      }
      if (input.toLowerCase() === "off") {
        const hadLoop = loop.active;
        loop.stop(true);
        updateStatus(ctx);
        notify(ctx, hadLoop ? "Loop cancelled." : "No active loop.", "info");
        return;
      }
      const space = input.search(/\s/);
      if (space < 0) {
        notify(ctx, usage, "error");
        return;
      }
      const intervalToken = input.slice(0, space);
      const prompt = input.slice(space + 1).trim();
      const parsed = parseInterval(intervalToken);
      if (!parsed) {
        notify(ctx, `Invalid interval "${intervalToken}". ${usage}`, "error");
        return;
      }
      if (!prompt) {
        notify(ctx, usage, "error");
        return;
      }
      const clamped = parsed.ms < config.loopMinIntervalMs;
      const intervalMs = clamped ? config.loopMinIntervalMs : parsed.ms;
      const intervalLabel = clamped ? formatInterval(intervalMs) : parsed.label;
      const replaced = loop.active;
      loop.start({ intervalMs, intervalLabel, prompt, startedAt: Date.now() }, true);
      updateStatus(ctx);
      const clampNote = clamped ? ` (raised to the ${formatInterval(config.loopMinIntervalMs)} minimum)` : "";
      notify(
        ctx,
        `${replaced ? "Loop replaced" : "Loop armed"}: every ${intervalLabel}${clampNote} — ${prompt}\nTicks are skipped while the agent is busy. Use /loop off to cancel.`,
        "info",
      );
    },
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const options: AutocompleteItem[] = [
        { value: "off", label: "off", description: "Cancel the active loop" },
        { value: "30s", label: "30s", description: "Every 30 seconds" },
        { value: "5m", label: "5m", description: "Every 5 minutes" },
        { value: "1h", label: "1h", description: "Every hour" },
      ];
      const filtered = options.filter(option => option.value.startsWith(prefix.toLowerCase()));
      return filtered.length > 0 ? filtered : null;
    },
  });
}
