import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SegmentState } from "../status/index.ts";
import { UsageTracker, type SessionSnapshot } from "../usage/index.ts";
import { appendHistory } from "../usage/store.ts";
import { renderSession, renderStats } from "../usage/report.ts";
import type { UsageConfig } from "../usage/config.ts";

const SINK_KEY = Symbol.for("piconfig.usage.sink");

type Sink = (message: unknown, model: unknown) => void;

interface MessageEndEvent {
  message?: unknown;
}

function symbolHost(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>;
}

function forwardToSink(message: unknown, model: unknown): void {
  const sink = symbolHost()[SINK_KEY];

  if (typeof sink === "function") {
    try {
      (sink as Sink)(message, model);
    } catch {}
  }
}

function activeModelId(ctx: ExtensionContext): string {
  const model: unknown = ctx.model;

  if (model !== null && typeof model === "object" && !Array.isArray(model)) {
    const id = (model as Record<string, unknown>).id;

    if (typeof id === "string" && id.trim() !== "") {
      return id.trim();
    }
  }

  return "unknown";
}

function sessionFileOf(ctx: ExtensionContext): string {
  try {
    const file: unknown = ctx.sessionManager.getSessionFile();

    return typeof file === "string" ? file : "";
  } catch {
    return "";
  }
}

function restoreFromEntries(tracker: UsageTracker, ctx: ExtensionContext): void {
  let entries: unknown;

  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    return;
  }

  if (!Array.isArray(entries)) {
    return;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry === null || typeof entry !== "object") {
      continue;
    }

    const record = entry as Record<string, unknown>;

    if (record.type !== "custom" || record.customType !== "usage") {
      continue;
    }

    const data = record.data !== undefined ? record.data : record.details;

    if (tracker.restore(data)) {
      return;
    }
  }
}

function deliver(ctx: ExtensionCommandContext, text: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, "info");

    return;
  }

  console.log(text);
}

export class UsageRegistrar {
  readonly #pi: ExtensionAPI;
  readonly #config: UsageConfig;
  readonly #tracker: UsageTracker;
  readonly #segments: SegmentState;
  readonly #depth: number;

  constructor(
    pi: ExtensionAPI,
    config: UsageConfig,
    tracker: UsageTracker,
    segments: SegmentState,
    depth: number,
  ) {
    this.#pi = pi;
    this.#config = config;
    this.#tracker = tracker;
    this.#segments = segments;
    this.#depth = depth;
  }

  register(): void {
    const pi = this.#pi;

    if (this.#depth > 0) {
      pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
        forwardToSink(event?.message, ctx.model);

        return undefined;
      });

      return;
    }

    const tracker = this.#tracker;
    const segments = this.#segments;
    const host = symbolHost();
    const sink: Sink = (message: unknown, model: unknown): void => {
      tracker.record(message, model);
    };
    host[SINK_KEY] = sink;

    pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
      tracker.reset();
      restoreFromEntries(tracker, ctx);
    });

    pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
      try {
        tracker.record(event?.message, ctx.model);
      } catch {}

      return undefined;
    });

    pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
      try {
        segments.applyUsage(tracker.endTurn(activeModelId(ctx)));
      } catch {}
    });

    pi.on("agent_end", () => {
      if (!tracker.hasData()) {
        return;
      }

      try {
        pi.appendEntry("usage", tracker.snapshot() as unknown as Record<string, unknown>);
      } catch {}
    });

    pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
      if (host[SINK_KEY] === sink) {
        delete host[SINK_KEY];
      }

      if (!tracker.hasNewData()) {
        return;
      }

      try {
        const delta = tracker.delta();
        appendHistory({
          date: new Date().toISOString(),
          sessionFile: sessionFileOf(ctx),
          models: delta.models,
          totals: delta.totals,
        });
      } catch {}
    });

    this.#registerCommands();
  }

  #registerCommands(): void {
    const pi = this.#pi;
    const tracker = this.#tracker;
    const config = this.#config;

    pi.registerCommand("usage", {
      description: "Show token and cost usage for the current session, per model",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const snapshot: SessionSnapshot = tracker.snapshot();
        deliver(ctx, renderSession(snapshot, config.costDecimals));
      },
    });

    pi.registerCommand("stats", {
      description: `Aggregate global usage history into daily and per-model tables (last ${config.statsDays} days)`,
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        deliver(ctx, renderStats(config.statsDays, config.costDecimals));
      },
    });
  }
}
