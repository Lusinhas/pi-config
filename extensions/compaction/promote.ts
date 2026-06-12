import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionConfig } from "./index";

export type AgentModel = NonNullable<ExtensionContext["model"]>;

export interface SharedState {
  originalModel: AgentModel | null;
  hasPromotionHeadroom: (ctx: ExtensionContext) => boolean;
  restoreOriginalModel: (ctx: ExtensionContext) => Promise<boolean>;
}

export function createSharedState(): SharedState {
  return {
    originalModel: null,
    hasPromotionHeadroom: () => false,
    restoreOriginalModel: async () => false,
  };
}

interface ModelFields {
  id?: unknown;
  provider?: unknown;
  name?: unknown;
  contextWindow?: unknown;
}

function listModels(registry: ExtensionContext["modelRegistry"]): AgentModel[] {
  const surface = registry as unknown as {
    getAll?: () => AgentModel[];
    getAvailable?: () => AgentModel[];
  };
  try {
    if (typeof surface.getAll === "function") {
      return surface.getAll();
    }
    if (typeof surface.getAvailable === "function") {
      return surface.getAvailable();
    }
  } catch {
    return [];
  }
  return [];
}

function windowOf(model: AgentModel): number {
  const fields = model as unknown as ModelFields;
  return typeof fields.contextWindow === "number" && Number.isFinite(fields.contextWindow) ? fields.contextWindow : 0;
}

function idOf(model: AgentModel): string {
  const fields = model as unknown as ModelFields;
  return typeof fields.id === "string" ? fields.id : "";
}

function providerOf(model: AgentModel): string {
  const fields = model as unknown as ModelFields;
  return typeof fields.provider === "string" ? fields.provider : "";
}

function nameOf(model: AgentModel): string {
  const fields = model as unknown as ModelFields;
  return typeof fields.name === "string" ? fields.name : "";
}

function matchesRef(model: AgentModel, ref: string): boolean {
  const needle = ref.trim().toLowerCase();
  const id = idOf(model).toLowerCase();
  const provider = providerOf(model).toLowerCase();
  const name = nameOf(model).toLowerCase();
  return needle === id || needle === `${provider}/${id}` || (name.length > 0 && needle === name);
}

function sameModel(a: AgentModel, b: AgentModel): boolean {
  return idOf(a) === idOf(b) && providerOf(a) === providerOf(b);
}

export function registerPromotion(pi: ExtensionAPI, config: CompactionConfig, state: SharedState): void {
  const ladderCandidates = (ctx: ExtensionContext): AgentModel[] => {
    if (!config.promotion.enabled || config.promotion.ladder.length === 0) {
      return [];
    }
    const current = ctx.model;
    if (!current) {
      return [];
    }
    const currentWindow = windowOf(current);
    const models = listModels(ctx.modelRegistry);
    const resolved: AgentModel[] = [];
    for (const ref of config.promotion.ladder) {
      const match = models.find((model) => matchesRef(model, ref));
      if (match && !sameModel(match, current) && windowOf(match) > currentWindow) {
        if (!resolved.some((existing) => sameModel(existing, match))) {
          resolved.push(match);
        }
      }
    }
    resolved.sort((a, b) => windowOf(a) - windowOf(b));
    return resolved;
  };

  state.hasPromotionHeadroom = (ctx: ExtensionContext): boolean => {
    try {
      return ladderCandidates(ctx).length > 0;
    } catch {
      return false;
    }
  };

  state.restoreOriginalModel = async (ctx: ExtensionContext): Promise<boolean> => {
    const original = state.originalModel;
    if (!original) {
      return false;
    }
    state.originalModel = null;
    try {
      const models = listModels(ctx.modelRegistry);
      const live = models.find((model) => sameModel(model, original)) ?? original;
      const ok = await pi.setModel(live);
      if (ok) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Context promotion reverted: restored ${providerOf(original)}/${idOf(original)}`, "info");
        }
        return true;
      }
      state.originalModel = original;
      return false;
    } catch {
      state.originalModel = original;
      return false;
    }
  };

  let promoting = false;
  pi.on("turn_end", async (_event, ctx) => {
    if (promoting) {
      return;
    }
    promoting = true;
    try {
      if (config.promotePct <= 0 || config.promotePct >= 100) {
        return;
      }
      const usage = ctx.getContextUsage();
      if (!usage || usage.percent === null || usage.percent === undefined) {
        return;
      }
      if (usage.percent < config.promotePct) {
        return;
      }
      const current = ctx.model;
      if (!current) {
        return;
      }
      const candidates = ladderCandidates(ctx);
      if (candidates.length === 0) {
        return;
      }
      const pct = Math.round(usage.percent);
      for (const candidate of candidates) {
        const ok = await pi.setModel(candidate);
        if (!ok) {
          continue;
        }
        if (!state.originalModel) {
          state.originalModel = current;
        }
        if (ctx.hasUI) {
          const window = windowOf(candidate);
          ctx.ui.notify(
            `Context at ${pct}% — promoted to ${providerOf(candidate)}/${idOf(candidate)} (${window.toLocaleString()} token window) instead of compacting; the original model is restored on /handoff or a new session`,
            "warning",
          );
        }
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Context at ${pct}% but no promotion ladder model could be activated; falling back to compaction`,
          "warning",
        );
      }
    } catch {
      return;
    } finally {
      promoting = false;
    }
  });

  pi.on("session_start", async (event, ctx) => {
    try {
      const reason = (event as { reason?: unknown }).reason;
      if (reason === "resume") {
        return;
      }
      if (!state.originalModel) {
        return;
      }
      await state.restoreOriginalModel(ctx);
    } catch {
      return;
    }
  });
}
