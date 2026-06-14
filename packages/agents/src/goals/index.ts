import type { GoalsConfig } from "./config.ts";
import { Judge } from "./judge.ts";
import type { GoalVerdict, JudgeRegistry } from "./judge.ts";
import { Interval, LoopRunner } from "./loop.ts";
import type { LoopSpec } from "./loop.ts";
import { Text } from "./text.ts";

export interface GoalState {
  condition: string;
  iterations: number;
  startedAt: number;
}

export interface TodoSnapshot {
  open: number;
  items: unknown[];
}

export type NotifyLevel = "info" | "warning" | "error";

export interface EnginePorts {
  notify(message: string, level: NotifyLevel): void;
  setStatus(text: string | undefined): void;
  sendUserMessage(prompt: string, options?: { deliverAs: "followUp" }): void;
  appendEntry(customType: string, data: Record<string, unknown>): void;
  registry(): JudgeRegistry;
  entries(): readonly unknown[];
}

export const GOAL_ENTRY = "goals:goal";

export const LOOP_ENTRY = "goals:loop";

const NUDGE_TODO_CAP = 20;

class JudgeSession {
  readonly state: GoalState;
  readonly controller: AbortController;

  constructor(state: GoalState) {
    this.state = state;
    this.controller = new AbortController();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(): void {
    this.controller.abort();
  }

  supersededBy(active: GoalState | undefined): boolean {
    return active !== this.state || this.signal.aborted;
  }
}

export class GoalEngine {
  #config: GoalsConfig;
  #judge: Judge;
  #ports: EnginePorts;
  #loop: LoopRunner;
  #goal: GoalState | undefined;
  #session: JudgeSession | undefined;
  #todos: TodoSnapshot | undefined;

  constructor(config: GoalsConfig, judge: Judge, loop: LoopRunner, ports: EnginePorts) {
    this.#config = config;
    this.#judge = judge;
    this.#ports = ports;
    this.#loop = loop;
  }

  get loop(): LoopRunner {
    return this.#loop;
  }

  get goal(): GoalState | undefined {
    return this.#goal;
  }

  ingestTodos(payload: unknown): void {

    if (!Text.isRecord(payload)) {
      return;
    }

    const open = typeof payload.open === "number" && Number.isFinite(payload.open) ? Math.max(0, payload.open) : 0;
    const items = Array.isArray(payload.items) ? payload.items : [];
    this.#todos = { open, items };
  }

  abortJudge(): void {

    if (this.#session) {
      this.#session.abort();
      this.#session = undefined;
    }
  }

  shutdown(): void {
    this.abortJudge();
    this.#loop.stop(false);
  }

  persistGoal(): void {
    const goal = this.#goal;

    try {

      if (goal) {
        this.#ports.appendEntry(GOAL_ENTRY, {
          active: true,
          condition: goal.condition,
          iterations: goal.iterations,
          startedAt: goal.startedAt,
        });
      } else {
        this.#ports.appendEntry(GOAL_ENTRY, { active: false });
      }
    } catch {
      return;
    }
  }

  clearGoal(): void {
    this.abortJudge();
    this.#goal = undefined;
    this.persistGoal();
    this.updateStatus();
  }

  clipLine(text: string): string {
    return Text.clipLine(text, this.#config.statusMaxChars);
  }

  updateStatus(): void {
    this.#ports.setStatus(this.statusWidget());
  }

  statusWidget(): string | undefined {
    const parts: string[] = [];
    const goal = this.#goal;

    if (goal) {
      parts.push(`goal ${goal.iterations}/${this.#config.maxIterations}: ${this.clipLine(goal.condition)}`);
    }

    const spec = this.#loop.spec;

    if (spec) {
      parts.push(`loop ${spec.intervalLabel}: ${this.clipLine(spec.prompt)}`);
    }

    return parts.length > 0 ? parts.join("  ") : undefined;
  }

  openTodoLabels(): string[] {
    const todos = this.#todos;

    if (!todos) {
      return [];
    }

    return Text.openTodoLabels(todos.open, todos.items);
  }

  buildNudge(state: GoalState, verdict: GoalVerdict, openItems: string[]): string {
    const lines: string[] = [
      "[goal] The completion condition is not yet met.",
      `Condition: ${state.condition}`,
      `Judge (${verdict.source}): ${verdict.reason}`,
    ];

    if (openItems.length > 0) {
      lines.push("Open todos:");
      const shown = openItems.slice(0, NUDGE_TODO_CAP);

      for (const item of shown) {
        lines.push(`- ${item}`);
      }

      if (openItems.length > shown.length) {
        lines.push(`- …and ${openItems.length - shown.length} more`);
      }
    }

    lines.push(`Continuation ${state.iterations}/${this.#config.maxIterations}.`);
    lines.push(
      `Keep working toward the condition. When it is fully satisfied, state that clearly and include ${this.#config.metMarker} in your final message. If it is impossible or you are blocked, say so explicitly instead of repeating the same approach.`,
    );

    return lines.join("\n");
  }

  statusText(): string {
    const lines: string[] = [];
    const goal = this.#goal;

    if (goal) {
      lines.push(`Goal: ${goal.condition}`);
      lines.push(`Continuations: ${goal.iterations}/${this.#config.maxIterations}`);
      lines.push(`Judge model: ${this.#config.judgeModel} (fallback marker: ${this.#config.metMarker})`);
      lines.push(`Todo enforcement: ${this.#config.enforceTodos ? "on" : "off"}`);

      if (this.#config.enforceTodos && this.#todos) {
        lines.push(`Open todos: ${this.#todos.open}`);
      }
    } else {
      lines.push("No active goal.");
    }

    const spec = this.#loop.spec;

    if (spec) {
      lines.push(`Loop: every ${spec.intervalLabel} — ${spec.prompt} (${this.#loop.ticks} sent, ${this.#loop.skipped} skipped)`);
    } else {
      lines.push("No active loop.");
    }

    return lines.join("\n");
  }

  armGoal(input: string): void {
    this.abortJudge();
    const replaced = this.#goal !== undefined;
    this.#goal = { condition: input, iterations: 0, startedAt: Date.now() };
    this.persistGoal();
    this.updateStatus();
    this.#ports.notify(
      `${replaced ? "Goal replaced" : "Goal armed"}: ${input}\nJudged by ${this.#config.judgeModel} after each agent run, capped at ${this.#config.maxIterations} continuations. Use /goal off to stop.`,
      "info",
    );
  }

  handleGoal(args: string): void {
    const input = (args ?? "").trim();

    if (!input || input.toLowerCase() === "status") {
      this.#ports.notify(this.statusText(), "info");

      return;
    }

    if (input.toLowerCase() === "off") {
      const hadGoal = this.#goal !== undefined;
      this.clearGoal();
      this.#ports.notify(hadGoal ? "Goal cleared." : "No active goal.", "info");

      return;
    }

    this.armGoal(input);
  }

  static readonly loopUsage =
    "Usage: /loop <interval> <prompt> with intervals like 30s, 5m, 1h, 90, 1h30m — or /loop off";

  handleLoop(args: string): void {
    const usage = GoalEngine.loopUsage;
    const input = (args ?? "").trim();

    if (!input) {
      const spec = this.#loop.spec;
      this.#ports.notify(
        spec ? `Loop active: every ${spec.intervalLabel} — ${spec.prompt}\n${usage}` : `No active loop.\n${usage}`,
        "info",
      );

      return;
    }

    if (input.toLowerCase() === "off") {
      const hadLoop = this.#loop.active;
      this.#loop.stop(true);
      this.updateStatus();
      this.#ports.notify(hadLoop ? "Loop cancelled." : "No active loop.", "info");

      return;
    }

    const space = input.search(/\s/);

    if (space < 0) {
      this.#ports.notify(usage, "error");

      return;
    }

    const intervalToken = input.slice(0, space);
    const prompt = input.slice(space + 1).trim();
    const parsed = Interval.parse(intervalToken);

    if (!parsed) {
      this.#ports.notify(`Invalid interval "${intervalToken}". ${usage}`, "error");

      return;
    }

    if (!prompt) {
      this.#ports.notify(usage, "error");

      return;
    }

    const clamped = parsed.ms < this.#config.loopMinIntervalMs;
    const intervalMs = clamped ? this.#config.loopMinIntervalMs : parsed.ms;
    const intervalLabel = clamped ? Interval.format(intervalMs) : parsed.label;
    const replaced = this.#loop.active;
    this.#loop.start({ intervalMs, intervalLabel, prompt, startedAt: Date.now() }, true);
    this.updateStatus();
    const clampNote = clamped ? ` (raised to the ${Interval.format(this.#config.loopMinIntervalMs)} minimum)` : "";
    this.#ports.notify(
      `${replaced ? "Loop replaced" : "Loop armed"}: every ${intervalLabel}${clampNote} — ${prompt}\nTicks are skipped while the agent is busy. Use /loop off to cancel.`,
      "info",
    );
  }

  async judgeAfterAgent(messages: readonly unknown[]): Promise<void> {

    if (!this.#goal || this.#session) {
      return;
    }

    const session = new JudgeSession(this.#goal);
    this.#session = session;

    try {
      const lastText = Text.lastAssistant(Array.isArray(messages) ? messages : []);
      const openItems = this.#config.enforceTodos ? this.openTodoLabels() : [];
      let verdict: GoalVerdict;

      if (openItems.length > 0) {

        verdict = {
          status: "unmet",
          reason: openItems.length === 1 ? "1 open todo remains" : `${openItems.length} open todos remain`,
          source: "todos",
        };
      } else {
        verdict = await this.#judge.judge({
          condition: session.state.condition,
          lastText,
          modelRef: this.#config.judgeModel,
          timeoutMs: this.#config.judgeTimeoutMs,
          maxChars: this.#config.judgeMaxChars,
          metMarker: this.#config.metMarker,
          registry: this.#ports.registry(),
          signal: session.signal,
        });
      }

      if (session.supersededBy(this.#goal)) {
        return;
      }

      this.applyVerdict(session.state, verdict, openItems);
    } finally {

      if (this.#session === session) {
        this.#session = undefined;
      }
    }
  }

  applyVerdict(state: GoalState, verdict: GoalVerdict, openItems: string[]): void {

    if (verdict.status === "met") {
      this.#ports.notify(`Goal met: ${verdict.reason}`, "info");
      this.clearGoal();

      return;
    }

    if (verdict.status === "blocked") {
      this.#ports.notify(`Goal blocked: ${verdict.reason}`, "warning");
      this.clearGoal();

      return;
    }

    if (state.iterations >= this.#config.maxIterations) {
      this.#ports.notify(
        `Goal stopped after ${this.#config.maxIterations} continuations without being met: ${state.condition}`,
        "warning",
      );
      this.clearGoal();

      return;
    }

    state.iterations += 1;
    this.persistGoal();
    this.updateStatus();
    this.#ports.sendUserMessage(this.buildNudge(state, verdict, openItems), { deliverAs: "followUp" });
  }

  restore(): void {
    this.abortJudge();
    this.#loop.stop(false);
    this.#goal = undefined;
    const { goalData, loopData } = this.scanEntries();

    if (goalData && goalData.active === true && typeof goalData.condition === "string" && goalData.condition.trim()) {

      this.#goal = {
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
      const intervalMs = Math.max(this.#config.loopMinIntervalMs, Math.round(loopData.intervalMs));
      const spec: LoopSpec = {
        intervalMs,
        intervalLabel:
          typeof loopData.intervalLabel === "string" && loopData.intervalLabel
            ? loopData.intervalLabel
            : Interval.format(intervalMs),
        prompt: loopData.prompt,
        startedAt: typeof loopData.startedAt === "number" ? loopData.startedAt : Date.now(),
      };
      this.#loop.start(spec, false);
    }

    this.updateStatus();
  }

  scanEntries(): { goalData?: Record<string, unknown>; loopData?: Record<string, unknown> } {
    let goalData: Record<string, unknown> | undefined;
    let loopData: Record<string, unknown> | undefined;

    try {
      const entries = this.#ports.entries();

      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];

        if (!Text.isRecord(entry) || entry.type !== "custom") {
          continue;
        }

        if (entry.customType === GOAL_ENTRY && !goalData && Text.isRecord(entry.data)) {
          goalData = entry.data;
        } else if (entry.customType === LOOP_ENTRY && !loopData && Text.isRecord(entry.data)) {
          loopData = entry.data;
        }

        if (goalData && loopData) {
          break;
        }
      }
    } catch {
      return {};
    }

    return { goalData, loopData };
  }
}
