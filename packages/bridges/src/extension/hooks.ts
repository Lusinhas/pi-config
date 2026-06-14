import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Dispatcher,
  History,
  basePayload,
  type DispatchOptions,
  type EventOutcome,
  type HooksConfig,
  type RawExec,
  type SessionInfo,
} from "../hooks/index.ts";
import { MonitorManager, type MonitorDeliverOptions, type MonitorMessage } from "../hooks/monitors.ts";
import { HookLoader, type HookEventName, type LoadedHooks } from "../hooks/schema.ts";
import { Reporter } from "../hooks/report.ts";
import type { LifecycleHub } from "./lifecycle.ts";

function sessionInfo(ctx: ExtensionContext): SessionInfo {
  let sessionFile = "";

  try {
    const file = ctx.sessionManager.getSessionFile();

    if (typeof file === "string") {
      sessionFile = file;
    }
  } catch {
    sessionFile = "";
  }

  return { sessionFile, cwd: ctx.cwd };
}

export class HooksRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: HooksConfig;
  private readonly hub: LifecycleHub;
  private readonly history: History;
  private readonly dispatcher: Dispatcher;
  private readonly loader: HookLoader;
  private readonly reporter: Reporter;
  private readonly monitors: MonitorManager;

  private loaded: LoadedHooks;

  constructor(pi: ExtensionAPI, config: HooksConfig, hub: LifecycleHub) {
    this.pi = pi;
    this.config = config;
    this.hub = hub;
    this.history = new History(config.historySize);
    this.loader = new HookLoader();
    this.reporter = new Reporter();

    const options: DispatchOptions = {
      shell: config.shell,
      eventBudgetMs: config.eventBudgetMs,
      maxOutputBytes: config.maxOutputBytes,
    };
    this.dispatcher = new Dispatcher((command, args, runOptions) => pi.exec(command, args, runOptions) as Promise<RawExec>, options);
    this.loaded = this.loader.load(process.cwd(), config.defaultTimeoutMs);

    const emit = (message: MonitorMessage, deliver: MonitorDeliverOptions): void => {
      try {
        pi.sendMessage(message, { deliverAs: deliver.deliverAs });
      } catch {
        return;
      }
    };
    this.monitors = new MonitorManager(
      emit,
      {
        specs: config.monitors,
        backoffInitialMs: config.backoff.initialMs,
        backoffMaxMs: config.backoff.maxMs,
        backoffResetAfterMs: config.backoff.resetAfterMs,
        killGraceMs: config.killGraceMs,
        maxLineLength: config.monitorMaxLineLength,
      },
      process.cwd(),
    );
  }

  register(): void {
    this.hub.on("tool_call", (event: { toolName?: unknown; input?: unknown }, ctx) => this.onPreToolUse(event, ctx));
    this.hub.on(
      "tool_result",
      (event: { toolName?: unknown; input?: unknown; content?: unknown; isError?: unknown }, ctx) =>
        this.onPostToolUse(event, ctx),
    );
    this.hub.on("input", (event: { text?: unknown; source?: unknown }, ctx) => this.onUserPrompt(event, ctx));
    this.hub.on("session_start", (event: { reason?: unknown }, ctx) => this.onSessionStart(event, ctx));
    this.hub.on("agent_end", (_event, ctx) => this.onStop(ctx));
    this.hub.on("session_before_compact", (event: { customInstructions?: unknown }, ctx) =>
      this.onPreCompact(event, ctx),
    );
    this.hub.on("session_shutdown", (event: { reason?: unknown }, ctx) => this.onSessionShutdown(event, ctx));

    this.registerHooksCommand();
  }

  private hasHooks(eventName: HookEventName): boolean {
    return this.loaded.events[eventName].length > 0;
  }

  private dispatch(
    eventName: HookEventName,
    toolName: string | null,
    payload: Record<string, unknown>,
  ): Promise<EventOutcome> {
    return this.dispatcher.dispatch(this.loaded, this.history, eventName, toolName, payload);
  }

  private async onPreToolUse(
    event: { toolName?: unknown; input?: unknown },
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    if (!this.hasHooks("PreToolUse")) {
      return undefined;
    }

    try {
      const toolName = typeof event.toolName === "string" ? event.toolName : "";
      const payload = { ...basePayload(sessionInfo(ctx), "PreToolUse"), tool_name: toolName, tool_input: event.input ?? {} };
      const result = await this.dispatch("PreToolUse", toolName, payload);

      return result.blocked ? { block: true, reason: result.reason } : undefined;
    } catch {
      return undefined;
    }
  }

  private async onPostToolUse(
    event: { toolName?: unknown; input?: unknown; content?: unknown; isError?: unknown },
    ctx: ExtensionContext,
  ): Promise<{ content: unknown[] } | undefined> {
    if (!this.hasHooks("PostToolUse")) {
      return undefined;
    }

    try {
      const toolName = typeof event.toolName === "string" ? event.toolName : "";
      const payload = {
        ...basePayload(sessionInfo(ctx), "PostToolUse"),
        tool_name: toolName,
        tool_input: event.input ?? {},
        tool_response: { content: event.content ?? [], is_error: event.isError === true },
      };
      const result = await this.dispatch("PostToolUse", toolName, payload);

      if (!result.blocked) {
        return undefined;
      }

      const existing = Array.isArray(event.content) ? event.content : [];

      return { content: [...existing, { type: "text", text: `PostToolUse hook feedback: ${result.reason}` }] };
    } catch {
      return undefined;
    }
  }

  private async onUserPrompt(
    event: { text?: unknown; source?: unknown },
    ctx: ExtensionContext,
  ): Promise<{ action: string; text?: string } | undefined> {
    if (!this.hasHooks("UserPromptSubmit")) {
      return undefined;
    }

    try {
      const promptText = typeof event.text === "string" ? event.text : "";
      const payload = { ...basePayload(sessionInfo(ctx), "UserPromptSubmit"), prompt: promptText };
      const result = await this.dispatch("UserPromptSubmit", null, payload);

      if (result.blocked) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Prompt blocked by UserPromptSubmit hook: ${result.reason}`, "warning");
        }

        return { action: "handled" };
      }

      if (result.context.length > 0 && promptText.length > 0) {
        return { action: "transform", text: `${promptText}\n\n${result.context.join("\n")}` };
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private async onSessionStart(event: { reason?: unknown }, ctx: ExtensionContext): Promise<undefined> {
    try {
      this.loaded = this.loader.load(ctx.cwd, this.config.defaultTimeoutMs);
      this.monitors.start(ctx.cwd);

      if (!this.hasHooks("SessionStart")) {
        return undefined;
      }

      const payload = {
        ...basePayload(sessionInfo(ctx), "SessionStart"),
        source: typeof event.reason === "string" ? event.reason : "startup",
      };
      await this.dispatch("SessionStart", null, payload);
    } catch {
      return undefined;
    }

    return undefined;
  }

  private async onStop(ctx: ExtensionContext): Promise<undefined> {
    if (!this.hasHooks("Stop")) {
      return undefined;
    }

    try {
      const payload = { ...basePayload(sessionInfo(ctx), "Stop"), stop_hook_active: false };
      await this.dispatch("Stop", null, payload);
    } catch {
      return undefined;
    }

    return undefined;
  }

  private async onPreCompact(
    event: { customInstructions?: unknown },
    ctx: ExtensionContext,
  ): Promise<{ cancel: true } | undefined> {
    if (!this.hasHooks("PreCompact")) {
      return undefined;
    }

    try {
      const custom = typeof event.customInstructions === "string" ? event.customInstructions : "";
      const payload = {
        ...basePayload(sessionInfo(ctx), "PreCompact"),
        trigger: custom.length > 0 ? "manual" : "auto",
        custom_instructions: custom,
      };
      const result = await this.dispatch("PreCompact", null, payload);

      if (result.blocked) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Compaction cancelled by PreCompact hook: ${result.reason}`, "warning");
        }

        return { cancel: true };
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  private async onSessionShutdown(event: { reason?: unknown }, ctx: ExtensionContext): Promise<undefined> {
    try {
      if (this.hasHooks("SessionEnd")) {
        const payload = {
          ...basePayload(sessionInfo(ctx), "SessionEnd"),
          reason: typeof event.reason === "string" ? event.reason : "exit",
        };
        await this.dispatch("SessionEnd", null, payload);
      }
    } catch {
      return undefined;
    } finally {
      this.monitors.stop();
    }

    return undefined;
  }

  private registerHooksCommand(): void {
    this.pi.registerCommand("hooks", {
      description: "Show hooks, monitors, problems, and recent dispatches: /hooks [reload]",
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const arg = (args ?? "").trim().toLowerCase();

        if (arg === "reload") {
          this.loaded = this.loader.load(ctx.cwd, this.config.defaultTimeoutMs);

          if (!ctx.hasUI) {
            return;
          }

          const summary = this.reporter.reloadSummary(this.loaded);
          ctx.ui.notify(summary.text, summary.hasProblems ? "warning" : "info");
          return;
        }

        if (arg !== "") {
          if (ctx.hasUI) {
            ctx.ui.notify("usage: /hooks [reload]", "warning");
          }

          return;
        }

        if (!ctx.hasUI) {
          return;
        }

        const report = this.reporter.buildReport(
          this.loaded,
          this.monitors.statuses(),
          this.history,
          this.config,
          this.loader.paths(ctx.cwd),
        );
        ctx.ui.notify(report.text, report.hasProblems ? "warning" : "info");
      },
      getArgumentCompletions: (argument: string) => {
        const prefix = (argument ?? "").trim().toLowerCase();

        return "reload".startsWith(prefix) ? [{ value: "reload", label: "reload" }] : null;
      },
    });
  }
}
