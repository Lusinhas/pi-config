import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Modes, type Mode } from "../permissions/modes.ts";
import { ContentIntegrity } from "../permissions/integrity.ts";
import { Judge, type JudgeContext, type JudgeVerdict } from "../permissions/judge.ts";
import type { Evaluation } from "../permissions/index.ts";
import { isRecord } from "../permissions/text.ts";
import type { JudgeConfig, PermissionsConfig } from "../permissions/loader.ts";
import { ENTRY_TYPE, PermissionsService, type Approval, type DecisionResult } from "../permissions/state.ts";
import type { AskPlan } from "../permissions/plan.ts";

const BROKER_KEY = Symbol.for("piconfig.permissions.broker");
const SUBAGENT_MARKER_KEY = Symbol.for("piconfig.subagents.marker");
const TOOLVIEW_KEY = Symbol.for("piconfig.toolview");
const IDE_KEY = Symbol.for("piconfig.ide");

interface PermissionBroker {
  decide(toolName: string, input: unknown, origin: string): Promise<DecisionResult>;
  mode(): Mode;
}

interface ToolViewBridge {
  render(toolName: string, input: unknown, overrides?: { cwd?: string; maxLines?: number; maxLineChars?: number }): string[];
  selectWithPreview(
    ctx: ExtensionContext,
    params: { title: string; preview: string[]; footer: string[]; options: string[]; signal?: AbortSignal },
  ): Promise<string | undefined>;
}

interface IdeOutcome {
  decision: "accept" | "reject";
  content: string;
  edited: boolean;
  beforeText: string;
}

interface IdeBridge {
  isConnected(): Promise<boolean>;
  requestDiffApproval(req: { toolName: string; input: Record<string, unknown>; cwd: string; signal?: AbortSignal }): Promise<IdeOutcome | undefined>;
}

class Bridges {
  private static host(): Record<symbol, unknown> {
    return globalThis as unknown as Record<symbol, unknown>;
  }

  static toolView(): ToolViewBridge | undefined {
    const candidate = Bridges.host()[TOOLVIEW_KEY];

    if (isRecord(candidate) && typeof candidate.render === "function" && typeof candidate.selectWithPreview === "function") {
      return candidate as unknown as ToolViewBridge;
    }

    return undefined;
  }

  static ide(): IdeBridge | undefined {
    const candidate = Bridges.host()[IDE_KEY];

    if (isRecord(candidate) && typeof candidate.isConnected === "function" && typeof candidate.requestDiffApproval === "function") {
      return candidate as unknown as IdeBridge;
    }

    return undefined;
  }

  static marker(): { depth: number; label: string } {
    const state = Bridges.host()[SUBAGENT_MARKER_KEY];

    if (!isRecord(state)) {
      return { depth: 0, label: "" };
    }

    const depth = typeof state.depth === "number" && Number.isFinite(state.depth) ? state.depth : 0;
    const label = typeof state.label === "string" ? state.label : "";

    return { depth, label };
  }

  static broker(): PermissionBroker | undefined {
    const candidate = Bridges.host()[BROKER_KEY];

    if (isRecord(candidate) && typeof candidate.decide === "function" && typeof candidate.mode === "function") {
      return candidate as unknown as PermissionBroker;
    }

    return undefined;
  }

  static publish(broker: PermissionBroker): void {
    Bridges.host()[BROKER_KEY] = broker;
  }

  static unpublish(broker: PermissionBroker): void {
    const host = Bridges.host();

    if (host[BROKER_KEY] === broker) {
      delete host[BROKER_KEY];
    }
  }
}

class JudgeRunner {
  async run(
    toolName: string,
    argument: string,
    config: JudgeConfig,
    ctx: ExtensionContext,
    context: JudgeContext,
  ): Promise<JudgeVerdict | undefined> {
    try {
      const request = Judge.buildRequest(toolName, argument, config, context);

      if (!request) {
        return undefined;
      }

      const model = ctx.modelRegistry.find(request.provider, request.modelId);

      if (!model) {
        return undefined;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);

      if (!auth.ok) {
        return undefined;
      }

      const response = await completeSimple(
        model,
        {
          systemPrompt: request.systemPrompt,
          messages: [{ role: "user", content: request.userPrompt, timestamp: Date.now() }],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: Judge.buildSignal(request.timeoutMs, ctx.signal),
          timeoutMs: request.timeoutMs,
          maxTokens: request.maxTokens,
        },
      );

      if (response.stopReason === "error" || response.stopReason === "aborted") {
        return undefined;
      }

      const text = response.content
        .map((block: { type: string; text?: string }) => (block.type === "text" ? block.text ?? "" : ""))
        .filter((piece: string) => piece.length > 0)
        .join("\n")
        .trim();

      return Judge.parseVerdict(text);
    } catch {
      return undefined;
    }
  }
}

export class PermissionsRegistrar {
  private readonly service: PermissionsService;
  private readonly judge = new JudgeRunner();
  private readonly integrity = new ContentIntegrity();
  private readonly marker = Bridges.marker();
  private lastCtx: ExtensionContext | undefined;
  private lastPrompt = "";
  private askQueue: Promise<unknown> = Promise.resolve();
  private publishedBroker: PermissionBroker | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly config: PermissionsConfig,
  ) {
    this.service = new PermissionsService(this.config);
  }

  register(): void {
    this.pi.on("session_shutdown", () => this.onShutdown());
    this.pi.on("session_start", (_event, ctx) => this.onSessionStart(ctx));
    this.pi.on("before_agent_start", (event: { prompt?: unknown }) => this.onBeforeAgentStart(event));
    this.pi.on("tool_call", (event, ctx) => this.onToolCall(event, ctx));

    this.pi.registerCommand("mode", {
      description: "Cycle the permissions approval mode or set it directly (ask | auto | write | yolo)",
      getArgumentCompletions: (prefix: string) => this.service.modeCompletions(prefix),
      handler: async (args, ctx) => this.onModeCommand(args, ctx),
    });

    this.pi.registerCommand("permissions", {
      description: "Show the permissions mode, effective rules, judge status, and session approvals",
      handler: async (_args, ctx) => this.onPermissionsCommand(ctx),
    });
  }

  private enqueueAsk<T>(run: () => Promise<T>): Promise<T> {
    const next = this.askQueue.then(run, run);

    this.askQueue = next.catch(() => undefined);

    return next;
  }

  private updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.setStatus("permissions", this.service.statusText());
  }

  private applyMode(mode: Mode, ctx: ExtensionContext, announce: boolean): void {
    const changed = this.service.setMode(mode);

    if (changed) {
      this.pi.appendEntry(ENTRY_TYPE, { kind: "clear" });
      this.pi.appendEntry(ENTRY_TYPE, { kind: "mode", mode });
      this.pi.events.emit("piconfig:mode", { mode });
    }

    this.updateStatus(ctx);

    if (announce && ctx.hasUI) {
      ctx.ui.notify(this.service.modeAnnouncement(mode), "info");
    }
  }

  private recordApprovals(approvals: Approval[]): void {
    for (const approval of approvals) {
      this.service.recordApproval(approval);
    }
  }

  private async resolveAsk(
    toolName: string,
    input: unknown,
    evaluation: Evaluation,
    ctx: ExtensionContext,
    origin: string,
  ): Promise<DecisionResult> {
    const argument = this.service.normalizeArgument(toolName, input);
    const approval: Approval = { tool: toolName, argument };

    if (this.service.approvalActiveForMode(approval)) {
      return undefined;
    }

    let judgeNote = "";

    if (this.service.judgeGateActive()) {
      const verdict = await this.judge.run(toolName, argument, this.service.judgeConfig(), ctx, {
        origin,
        request: this.lastPrompt,
      });
      const outcome = this.service.applyJudgeVerdict(approval, verdict);

      this.recordApprovals(outcome.approvals);

      if (outcome.notify && ctx.hasUI) {
        ctx.ui.notify(outcome.notify, "info");
      }

      if (outcome.result !== undefined || outcome.approvals.length > 0) {
        return outcome.result;
      }

      judgeNote = outcome.judgeNote;
    }

    if (!ctx.hasUI) {
      return this.service.headlessAsk(toolName, evaluation);
    }

    const plan = this.service.buildAskPlan(toolName, argument, evaluation, judgeNote, origin);
    const ide = this.config.ideDiff && (toolName === "edit" || toolName === "write") ? Bridges.ide() : undefined;

    if (ide) {
      const raced = await this.raceApproval(ide, toolName, input, ctx, plan);

      if (raced.kind === "ide") {
        if (raced.outcome.decision === "reject") {
          return { block: true, reason: `permissions: ${toolName} rejected in the IDE diff` };
        }

        if (raced.outcome.edited) {
          this.patchToolInput(toolName, input, raced.outcome.content);
        }

        return undefined;
      }

      return this.applyChoice(toolName, evaluation, ctx, plan, raced.choice);
    }

    const choice = await this.prompt(toolName, input, ctx, plan.header, plan.footer, plan.choices, plan.preview);

    return this.applyChoice(toolName, evaluation, ctx, plan, choice);
  }

  private applyChoice(
    toolName: string,
    evaluation: Evaluation,
    ctx: ExtensionContext,
    plan: AskPlan,
    choice: string | undefined,
  ): DecisionResult {
    const result = this.service.resolveChoice(toolName, plan, evaluation, ctx.cwd, choice);

    this.recordApprovals(result.approvals);

    for (const entry of result.entries) {
      this.pi.appendEntry(ENTRY_TYPE, entry);
    }

    if (result.switchToAuto) {
      this.applyMode("auto", ctx, true);
    }

    return result.result;
  }

  private raceApproval(
    ide: IdeBridge,
    toolName: string,
    input: unknown,
    ctx: ExtensionContext,
    plan: AskPlan,
  ): Promise<{ kind: "ide"; outcome: IdeOutcome } | { kind: "prompt"; choice: string | undefined }> {
    const ideAbort = new AbortController();
    const promptAbort = new AbortController();

    return new Promise((resolve) => {
      let settled = false;

      void ide
        .requestDiffApproval({ toolName, input: input as Record<string, unknown>, cwd: ctx.cwd, signal: ideAbort.signal })
        .catch(() => undefined)
        .then((outcome) => {
          if (settled || !outcome) {
            return;
          }

          settled = true;
          promptAbort.abort();
          resolve({ kind: "ide", outcome });
        });

      void this.prompt(toolName, input, ctx, plan.header, plan.footer, plan.choices, plan.preview, promptAbort.signal)
        .catch(() => undefined)
        .then((choice) => {
          if (settled) {
            return;
          }

          settled = true;
          ideAbort.abort();
          resolve({ kind: "prompt", choice });
        });
    });
  }

  private patchToolInput(toolName: string, input: unknown, content: string): boolean {
    if (!isRecord(input)) {
      return false;
    }

    input.content = content;

    if (toolName !== "write") {
      delete input.edits;
      delete input.oldText;
      delete input.newText;
    }

    return true;
  }

  private async prompt(
    toolName: string,
    input: unknown,
    ctx: ExtensionContext,
    header: string,
    footer: string[],
    choices: string[],
    preview: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const toolView = Bridges.toolView();

    if (toolView) {
      try {
        const rendered = toolView.render(toolName, input, { cwd: ctx.cwd, maxLines: 0, maxLineChars: 0 });

        return await toolView.selectWithPreview(ctx, { title: header, preview: rendered, footer, options: choices, signal });
      } catch {
        return await this.fallbackPrompt(ctx, header, footer, choices, preview, signal);
      }
    }

    return await this.fallbackPrompt(ctx, header, footer, choices, preview, signal);
  }

  private async fallbackPrompt(
    ctx: ExtensionContext,
    header: string,
    footer: string[],
    choices: string[],
    preview: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const title = [header, preview.length > 0 ? `  ${preview}` : "  (no arguments)", ...footer].join("\n");

    return await ctx.ui.select(title, choices, { signal });
  }

  private async brokerDecide(toolName: string, input: unknown, origin: string): Promise<DecisionResult> {
    const corrupt = this.integrity.violation(toolName, input);

    if (corrupt !== undefined) {
      return { block: true, reason: `guard: ${corrupt}` };
    }

    const cwd = this.lastCtx?.cwd ?? process.cwd();
    const evaluation = this.service.evaluate(toolName, input, cwd);
    const mapped = this.service.mapEvaluation(evaluation);

    if (mapped !== "ask") {
      return mapped;
    }

    const ctx = this.lastCtx;

    if (!ctx) {
      return this.service.headlessBroker(toolName, origin);
    }

    return this.enqueueAsk(() => this.resolveAsk(toolName, input, evaluation, ctx, origin));
  }

  private publishBroker(): void {
    if (this.marker.depth > 0 || !this.config.subagentBridge) {
      return;
    }

    this.publishedBroker = {
      decide: (toolName, input, origin) => this.brokerDecide(toolName, input, origin),
      mode: () => this.service.currentMode(),
    };
    Bridges.publish(this.publishedBroker);
  }

  private onShutdown(): void {
    if (this.publishedBroker === undefined) {
      return;
    }

    Bridges.unpublish(this.publishedBroker);
    this.publishedBroker = undefined;
  }

  private onSessionStart(ctx: ExtensionContext): void {
    this.lastCtx = ctx;
    this.publishBroker();
    this.service.reset();

    const mode = this.service.replay(ctx.sessionManager.getEntries());

    this.pi.events.emit("piconfig:mode", { mode });
    this.updateStatus(ctx);
  }

  private onBeforeAgentStart(event: { prompt?: unknown }): void {
    if (typeof event.prompt === "string" && event.prompt.trim() !== "") {
      this.lastPrompt = event.prompt;
    }
  }

  private async onToolCall(
    event: { toolName: string; input: unknown },
    ctx: ExtensionContext,
  ): Promise<DecisionResult> {
    try {
      const corrupt = this.integrity.violation(event.toolName, event.input);

      if (corrupt !== undefined) {
        return { block: true, reason: `guard: ${corrupt}` };
      }

      if (this.marker.depth > 0 && this.config.subagentBridge) {
        const broker = Bridges.broker();

        if (broker) {
          const origin = this.marker.label !== "" ? this.marker.label : `subagent depth ${this.marker.depth}`;

          return await broker.decide(event.toolName, event.input, origin);
        }
      }

      this.lastCtx = ctx;

      const evaluation = this.service.evaluate(event.toolName, event.input, ctx.cwd);
      const mapped = this.service.mapEvaluation(evaluation);

      if (mapped !== "ask") {
        return mapped;
      }

      return await this.resolveAsk(event.toolName, event.input, evaluation, ctx, "");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      return this.service.failure(event.toolName, detail);
    }
  }

  private async onModeCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const requested = (args ?? "").trim().toLowerCase();

    if (requested.length > 0) {
      if (!Modes.is(requested)) {
        if (ctx.hasUI) {
          ctx.ui.notify(this.service.unknownModeMessage(requested), "error");
        }

        return;
      }

      this.applyMode(requested, ctx, true);

      return;
    }

    this.applyMode(Modes.next(this.service.currentMode()), ctx, true);
  }

  private onPermissionsCommand(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.notify(this.service.buildReport(), "info");
  }
}
