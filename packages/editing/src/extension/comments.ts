import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Checker } from "../comments/index.ts";
import type { CheckResult } from "../comments/index.ts";
import { Detector, Scanner } from "../comments/patterns.ts";
import { Reporter, MODE_DESCRIPTIONS } from "../comments/render.ts";
import { SessionState, ENTRY_TYPE } from "../comments/state.ts";
import type { SessionEntry } from "../comments/state.ts";
import { isMode, MODES } from "../comments/config.ts";
import type { CommentsConfig, Mode } from "../comments/config.ts";

export class CommentsRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: CommentsConfig;
  private readonly checker: Checker;
  private readonly reporter: Reporter;
  private readonly state: SessionState;

  constructor(pi: ExtensionAPI, config: CommentsConfig) {
    this.pi = pi;
    this.config = config;
    this.checker = new Checker(new Scanner(new Detector()));
    this.reporter = new Reporter();
    this.state = new SessionState(config.mode);
  }

  register(): void {
    this.registerSessionStart();
    this.registerToolCall();
    this.registerCommand();
  }

  private registerSessionStart(): void {
    this.pi.on("session_start", (_event, ctx) => {
      this.state.restore(() => ctx.sessionManager.getEntries() as Iterable<SessionEntry>);
    });
  }

  private registerToolCall(): void {
    this.pi.on("tool_call", (event, ctx) => {
      try {
        if (this.state.mode === "off") {
          return undefined;
        }

        const result = this.checker.runCheck(event.toolName, event.input, ctx.cwd, this.config);

        if (result === null) {
          return undefined;
        }

        this.state.recordResult(result);

        if (this.state.mode === "block") {
          return { block: true, reason: this.reporter.blockReason(result, this.config) };
        }

        this.maybeWarn(result);

        return undefined;
      } catch {
        return undefined;
      }
    });
  }

  private maybeWarn(result: CheckResult): void {
    const key = this.reporter.warnKey(result);

    if (!this.state.shouldWarn(key)) {
      return;
    }

    this.pi.sendMessage(
      { customType: "commentsnotice", content: this.reporter.warnNotice(result, this.config), display: true },
      { deliverAs: "followUp" },
    );
  }

  private registerCommand(): void {
    this.pi.registerCommand("comments", {
      description: "Show comment-police mode, set block | warn | off, or list last findings with /comments last",
      getArgumentCompletions: (argumentPrefix: string): Array<{ value: string; label: string }> | null => {
        const needle = argumentPrefix.trim().toLowerCase();
        const items = [
          { value: "block", label: "block — reject writes/edits that add slop comments" },
          { value: "warn", label: "warn — allow but send a follow-up notice" },
          { value: "off", label: "off — disable comment policing" },
          { value: "last", label: "last — list findings from recent checks" },
        ].filter((item) => item.value.startsWith(needle));

        return items.length > 0 ? items : null;
      },
      handler: async (args, ctx): Promise<void> => {
        const request = (args ?? "").trim().toLowerCase();

        if (request.length === 0) {
          this.notify(ctx, this.reporter.buildReport({ mode: this.state.mode, history: this.state.history }, this.config), "info");

          return;
        }

        if (isMode(request)) {
          this.applyMode(request, ctx);

          return;
        }

        if (request === "last" || request === "findings") {
          this.notify(ctx, this.reporter.buildHistory({ mode: this.state.mode, history: this.state.history }, this.config), "info");

          return;
        }

        this.notify(
          ctx,
          `comments: unknown argument "${request}" (usage: /comments | /comments ${MODES.join(" | ")} | /comments last)`,
          "error",
        );
      },
    });
  }

  private applyMode(mode: Mode, ctx: ExtensionContext): void {
    const outcome = this.state.applyMode(mode);

    if (outcome.changed) {
      try {
        this.pi.appendEntry(ENTRY_TYPE, { mode });
      } catch {
        void 0;
      }
    }

    this.notify(ctx, `comments mode: ${mode} (${MODE_DESCRIPTIONS[mode]})`, "info");
  }

  private notify(ctx: ExtensionContext, message: string, level: "info" | "error"): void {
    if (ctx.hasUI) {
      ctx.ui.notify(message, level);
    }
  }
}
