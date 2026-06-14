import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SEGMENT_IDS,
  SegmentState,
  computeSegments,
  type SegmentId,
  type SegmentPart,
  type StatuslineConfig,
} from "../status/index.ts";
import { GitWatcher, type GitExec } from "../status/git.ts";
import { FooterController, type FooterHost } from "../status/footer.ts";
import { SegmentStore } from "../status/store.ts";

class CtxRead {
  static modelId(model: unknown): string | null {
    if (typeof model === "string" && model.trim() !== "") {
      return model.trim();
    }

    if (model !== null && typeof model === "object") {
      const record = model as Record<string, unknown>;

      for (const key of ["id", "name"]) {
        const value = record[key];

        if (typeof value === "string" && value.trim() !== "") {
          return value.trim();
        }
      }
    }

    return null;
  }

  static contextPercent(ctx: ExtensionContext): number | null {
    try {
      const usage = ctx.getContextUsage();

      if (!usage) {
        return null;
      }

      const record = usage as { tokens?: number | null; contextWindow?: number; percent?: number | null };

      if (typeof record.percent === "number" && Number.isFinite(record.percent)) {
        return record.percent;
      }

      if (
        typeof record.tokens === "number" &&
        Number.isFinite(record.tokens) &&
        typeof record.contextWindow === "number" &&
        record.contextWindow > 0
      ) {
        return (record.tokens / record.contextWindow) * 100;
      }

      return null;
    } catch {
      return null;
    }
  }
}

class StatuslineCommand {
  readonly #config: StatuslineConfig;
  readonly #controller: FooterController;
  readonly #store: SegmentStore;

  constructor(config: StatuslineConfig, controller: FooterController, store: SegmentStore) {
    this.#config = config;
    this.#controller = controller;
    this.#store = store;
  }

  async run(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      return;
    }

    let changed = false;

    for (;;) {
      const options = this.#config.order.map(
        (id) => `${id}: ${this.#config.segments[id].enabled ? "on" : "off"}`,
      );
      const picked = await ctx.ui.select("Statusline segments", [...options, "done"]);

      if (picked === undefined || picked === "done") {
        break;
      }

      const id = picked.split(":")[0] as SegmentId;

      if (!(SEGMENT_IDS as readonly string[]).includes(id)) {
        continue;
      }

      const choice = await ctx.ui.select(`Segment "${id}"`, ["on", "off"]);

      if (choice !== "on" && choice !== "off") {
        continue;
      }

      const enabled = choice === "on";

      if (this.#config.segments[id].enabled !== enabled) {
        this.#config.segments[id] = { enabled };
        changed = true;
        this.#controller.refresh();
      }
    }

    if (!changed) {
      return;
    }

    const outcome = this.#store.persist(this.#config.segments);

    ctx.ui.notify(outcome.message, outcome.ok ? "info" : "error");
  }
}

export class StatuslineRegistrar {
  readonly #pi: ExtensionAPI;
  readonly #config: StatuslineConfig;
  readonly #segments: SegmentState;

  constructor(pi: ExtensionAPI, config: StatuslineConfig, segments: SegmentState) {
    this.#pi = pi;
    this.#config = config;
    this.#segments = segments;
  }

  register(): void {
    const pi = this.#pi;
    const config = this.#config;
    const state = this.#segments;
    const exec: GitExec = (command, args, options) => pi.exec(command, args, options);
    const git = new GitWatcher(exec, config.gitIntervalMs, config.gitTimeoutMs);
    const dir = join(homedir(), ".pi", "agent");
    const store = new SegmentStore(dir, join(dir, "suite.json"));

    let latestCtx: ExtensionContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const buildParts = (): SegmentPart[] => {
      const ctx = latestCtx;

      return computeSegments(config.order, config.segments, {
        modelId: ctx ? CtxRead.modelId(ctx.model) : null,
        contextPercent: ctx ? CtxRead.contextPercent(ctx) : null,
        cwd: ctx?.cwd ?? process.cwd(),
        git: git.current(),
        state,
        warnPercent: config.warnPercent,
        errorPercent: config.errorPercent,
        now: new Date(),
      });
    };

    const controller = new FooterController(config.separator, buildParts);
    const command = new StatuslineCommand(config, controller, store);

    const pollGit = (): void => {
      const ctx = latestCtx;

      if (!ctx || !controller.installed) {
        return;
      }

      git.poll(ctx.cwd ?? process.cwd(), () => controller.refresh());
    };

    const stopTimer = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    pi.events.on("piconfig:mode", (payload: unknown) => {
      state.applyMode(payload);
      controller.refresh();
    });

    pi.events.on("piconfig:role", (payload: unknown) => {
      state.applyRole(payload);
      controller.refresh();
    });

    pi.events.on("piconfig:ide", (payload: unknown) => {
      state.applyIde(payload);
      controller.refresh();
    });

    pi.events.on("piconfig:todos", (payload: unknown) => {
      state.applyTodos(payload);
      controller.refresh();
    });

    pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
      latestCtx = ctx;

      if (!ctx.hasUI) {
        return;
      }

      controller.install(ctx.ui as unknown as FooterHost);
      stopTimer();
      timer = setInterval(() => {
        controller.refresh();
        pollGit();
      }, config.refreshMs);
      timer.unref?.();
      pollGit();
    });

    pi.on("model_select", (_event: unknown, ctx: ExtensionContext) => {
      latestCtx = ctx;
      controller.refresh();
    });

    pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
      latestCtx = ctx;
      controller.refresh();
      pollGit();
    });

    pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
      stopTimer();

      if (ctx.hasUI) {
        controller.uninstall(ctx.ui as unknown as FooterHost);
      }
    });

    pi.registerCommand("statusline", {
      description: "Toggle statusline segments on or off and persist the layout",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        if (!ctx.hasUI) {
          return;
        }

        latestCtx = ctx;
        await command.run(ctx);
      },
    });
  }
}
