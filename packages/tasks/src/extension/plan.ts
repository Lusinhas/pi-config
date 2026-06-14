import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanConfig } from "../plan/settings.ts";
import { Gating, type GatingHost } from "../plan/index.ts";
import { Names, Render } from "../plan/names.ts";
import { Review, type ReviewHost } from "../plan/review.ts";
import { Store } from "../plan/store.ts";

class Bridge implements GatingHost, ReviewHost {
  private ctx: ExtensionContext | undefined;
  private gated: string[] = [];
  private gating: Gating | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly config: PlanConfig,
  ) {}

  bind(ctx: ExtensionContext | undefined): void {
    this.ctx = ctx;
  }

  allToolNames(): string[] {
    try {
      return Names.normalize(this.pi.getAllTools());
    } catch {
      return [];
    }
  }

  activeToolNames(): string[] {
    try {
      return Names.normalize(this.pi.getActiveTools());
    } catch {
      return [];
    }
  }

  async setActiveTools(names: string[]): Promise<void> {
    await this.pi.setActiveTools(names);
  }

  appendStateEntry(snapshot: string[], gated: string[], active: boolean): void {
    try {
      this.pi.appendEntry(Store.STATETYPE, Store.stateEntry(snapshot, gated, active));
    } catch {
      return;
    }
  }

  readEntries(): unknown {
    try {
      return this.ctx?.sessionManager.getEntries();
    } catch {
      return undefined;
    }
  }

  applyUi(active: boolean, gated: string[]): void {
    this.gated = [...gated];

    const ctx = this.ctx;

    if (!ctx || !ctx.hasUI) {
      return;
    }

    try {
      if (active) {
        ctx.ui.setStatus("plan", this.config.statusText);

        if (this.config.showWidget) {
          ctx.ui.setWidget("plan", Render.widgetLines(gated), { placement: "belowEditor" });
        } else {
          ctx.ui.setWidget("plan", undefined);
        }

        return;
      }

      ctx.ui.setStatus("plan", undefined);
      ctx.ui.setWidget("plan", undefined);
    } catch {
      return;
    }
  }

  hasUI(): boolean {
    return this.ctx?.hasUI === true;
  }

  active(): boolean {
    return this.gating?.state.active === true;
  }

  attach(gating: Gating): void {
    this.gating = gating;
  }

  async select(title: string, options: string[], timeoutMs: number): Promise<string | undefined> {
    const ctx = this.ctx;

    if (!ctx || !ctx.hasUI) {
      return undefined;
    }

    const dialogOptions = timeoutMs > 0 ? { timeout: timeoutMs } : undefined;

    return ctx.ui.select(title, options, dialogOptions);
  }

  async input(title: string, placeholder: string): Promise<string | undefined> {
    const ctx = this.ctx;

    if (!ctx || !ctx.hasUI) {
      return undefined;
    }

    return ctx.ui.input(title, placeholder);
  }

  appendApproved(text: string): void {
    try {
      this.pi.appendEntry(Store.APPROVEDTYPE, Store.approvedEntry(text));
    } catch {
      return;
    }
  }

  async exit(): Promise<void> {
    if (this.gating) {
      await this.gating.exit(true);
    }
  }

  sendApprove(): void {
    this.pi.sendMessage(
      { customType: "piconfig:plan:approve", content: this.config.approveMessage, display: true },
      { deliverAs: "steer", triggerTurn: true },
    );
  }

  sendRefine(feedback: string): void {
    this.pi.sendMessage(
      { customType: "piconfig:plan:refine", content: this.config.refinePrefix + feedback, display: true },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }
}

export class PlanRegistrar {
  private readonly bridge: Bridge;
  private readonly gating: Gating;
  private readonly review: Review;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly config: PlanConfig,
  ) {
    this.bridge = new Bridge(pi, config);
    this.gating = new Gating(this.bridge, config);
    this.bridge.attach(this.gating);
    this.review = new Review(this.bridge, this.gating.state, config);
  }

  register(): void {
    this.registerCommand();
    this.registerEvents();
  }

  private describeGated(): string {
    return Render.describeGated(this.gating.state.gated);
  }

  private async turnOn(ctx: ExtensionCommandContext): Promise<void> {
    this.bridge.bind(ctx);

    const entered = await this.gating.enter(true);

    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.notify(entered ? Render.enteredNotice(this.gating.state.gated) : Render.alreadyOnNotice(), "info");
  }

  private async turnOff(ctx: ExtensionCommandContext): Promise<void> {
    this.bridge.bind(ctx);

    const exited = await this.gating.exit(true);

    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.notify(exited ? Render.exitedNotice() : Render.alreadyOffNotice(), "info");
  }

  private show(ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.notify(
      this.gating.state.active ? Render.showActiveNotice(this.gating.state.gated) : Render.showInactiveNotice(),
      "info",
    );
  }

  private registerCommand(): void {
    this.pi.registerCommand("plan", {
      description: "Toggle plan mode (read-only tool gating): /plan, /plan on, /plan off, /plan show",
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const arg = (args ?? "").trim().toLowerCase();

        try {
          if (arg === "" || arg === "toggle") {
            if (this.gating.state.active) {
              await this.turnOff(ctx);
            } else {
              await this.turnOn(ctx);
            }
          } else if (arg === "on" || arg === "enter" || arg === "start") {
            await this.turnOn(ctx);
          } else if (arg === "off" || arg === "exit" || arg === "stop") {
            await this.turnOff(ctx);
          } else if (arg === "show" || arg === "status") {
            this.show(ctx);
          } else if (ctx.hasUI) {
            ctx.ui.notify(Render.usageNotice(), "warning");
          }
        } catch {
          if (ctx.hasUI) {
            ctx.ui.notify(Render.commandFailedNotice(""), "error");
          }
        }
      },
      getArgumentCompletions: (argument: string) => {
        const prefix = (argument ?? "").trim().toLowerCase();
        const matches = ["on", "off", "show"].filter((option) => option.startsWith(prefix));

        return matches.length > 0 ? matches.map((option) => ({ value: option, label: option })) : null;
      },
    });
  }

  private registerEvents(): void {
    this.pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
      this.bridge.bind(ctx);

      try {
        await this.gating.syncFromSession();
      } catch {
        return;
      }
    });

    this.pi.on("before_agent_start", (event: { systemPrompt?: unknown }) => {
      if (!this.gating.state.active) {
        return undefined;
      }

      return { systemPrompt: this.gating.systemPrompt(event.systemPrompt) };
    });

    this.pi.on("tool_call", (event: { toolName?: unknown }) => this.gating.evaluateToolCall(event.toolName));

    this.pi.on("turn_end", async (event: { message?: unknown; toolResults?: unknown }, ctx: ExtensionContext) => {
      this.bridge.bind(ctx);

      try {
        await this.review.reviewTurn(event);
      } catch {
        return;
      }
    });
  }
}

export function registerPlan(pi: ExtensionAPI, config: PlanConfig): void {
  new PlanRegistrar(pi, config).register();
}
