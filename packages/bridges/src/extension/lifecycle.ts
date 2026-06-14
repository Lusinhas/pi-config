import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SUBAGENT_MARKER_KEY = Symbol.for("piconfig.subagents.marker");

export function subagentDepth(): number {
  const host = globalThis as unknown as Record<symbol, unknown>;
  const state = host[SUBAGENT_MARKER_KEY];

  if (state !== null && typeof state === "object" && !Array.isArray(state)) {
    const depth = (state as Record<string, unknown>).depth;

    if (typeof depth === "number" && Number.isFinite(depth)) {
      return depth;
    }
  }

  return 0;
}

export type AsyncHandler<E, R> = (event: E, ctx: ExtensionContext) => Promise<R | undefined> | R | undefined;

interface Subscription<E, R> {
  handler: AsyncHandler<E, R>;
}

export class LifecycleHub {
  private readonly pi: ExtensionAPI;
  private readonly channels = new Map<string, Subscription<unknown, unknown>[]>();
  private readonly bound = new Set<string>();

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  on<E, R>(channel: string, handler: AsyncHandler<E, R>): void {
    const list = this.channels.get(channel) ?? [];
    list.push({ handler: handler as AsyncHandler<unknown, unknown> });
    this.channels.set(channel, list);
    this.bind(channel);
  }

  private bind(channel: string): void {
    if (this.bound.has(channel)) {
      return;
    }

    this.bound.add(channel);
    this.pi.on(channel, (event: unknown, ctx: ExtensionContext) => this.fanOut(channel, event, ctx));
  }

  private async fanOut(channel: string, event: unknown, ctx: ExtensionContext): Promise<unknown> {
    const subscriptions = this.channels.get(channel) ?? [];
    let merged: Record<string, unknown> | undefined;

    for (const subscription of subscriptions) {
      const result = await subscription.handler(event, ctx);

      if (result !== undefined && result !== null && typeof result === "object") {
        merged = merged === undefined ? { ...(result as Record<string, unknown>) } : { ...merged, ...(result as Record<string, unknown>) };
      }
    }

    return merged;
  }
}
