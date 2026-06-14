import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionConfig } from "../compaction/index.ts";
import { Messages, isRecord } from "../compaction/index.ts";
import { HANDOFFSYSTEM, Handoff } from "../compaction/handoff.ts";
import { Promotion, TurnCoordinator, type PromotionPlan } from "../compaction/promote.ts";
import { Shake, Supersede } from "../compaction/strategy.ts";

type AgentModel = NonNullable<ExtensionContext["model"]>;

interface AuthResult {
  ok: boolean;
  error?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

interface ModelRegistrySurface {
  getApiKeyAndHeaders?: (model: AgentModel) => Promise<AuthResult>;
  getApiKey?: (model: AgentModel) => Promise<string | undefined>;
  getAll?: () => AgentModel[];
  getAvailable?: () => AgentModel[];
}

interface SessionManagerSurface {
  appendMessage?: (message: unknown) => unknown;
}

export class CompactionRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: CompactionConfig;
  private readonly messages = new Messages();
  private readonly promotion: Promotion;
  private readonly coordinator: TurnCoordinator;
  private readonly supersede: Supersede;
  private readonly shake: Shake;
  private readonly handoff = new Handoff(this.messages);

  private originalModel: AgentModel | null = null;
  private shakeArmed = false;

  constructor(pi: ExtensionAPI, config: CompactionConfig) {
    this.pi = pi;
    this.config = config;
    this.promotion = new Promotion(config.promotion.ladder, config.promotion.enabled);
    this.coordinator = new TurnCoordinator(this.promotion, config.preemptPct, config.promotePct);
    this.supersede = new Supersede(this.messages, {
      keepRecentTokens: config.keepRecentTokens,
      dropOverBytes: config.dropOverBytes,
    });
    this.shake = new Shake(this.messages, config.shakeOverBytes);
  }

  register(): void {
    this.registerEvents();
    this.registerCommands();
  }

  private availableModels(ctx: ExtensionContext): AgentModel[] {
    const surface = ctx.modelRegistry as unknown as ModelRegistrySurface;

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

  private async resolveAuth(
    ctx: ExtensionContext,
    model: AgentModel,
  ): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
    const surface = ctx.modelRegistry as unknown as ModelRegistrySurface;

    if (typeof surface.getApiKeyAndHeaders === "function") {
      const auth = await surface.getApiKeyAndHeaders(model);

      if (!auth.ok) {
        throw new Error(auth.error || "model authentication failed");
      }

      return { apiKey: auth.apiKey, headers: auth.headers };
    }

    if (typeof surface.getApiKey === "function") {
      return { apiKey: await surface.getApiKey(model) };
    }

    return {};
  }

  private async restoreOriginalModel(ctx: ExtensionContext): Promise<boolean> {
    const original = this.originalModel;

    if (!original) {
      return false;
    }

    this.originalModel = null;

    try {
      const live = this.promotion.liveMatch(original, this.availableModels(ctx));
      const ok = await this.pi.setModel(live);

      if (ok) {
        if (ctx.hasUI) {
          ctx.ui.notify(this.promotion.restoredNotice(original), "info");
        }

        return true;
      }

      this.originalModel = original;

      return false;
    } catch {
      this.originalModel = original;

      return false;
    }
  }

  private helpText(): string {
    const config = this.config;
    const messages = this.messages;

    return [
      `/handoff [instructions] — ask the current model to write a handoff document (goal, current state, decisions, open items) over the recent session, save it to ${config.handoffPath}, then optionally start a fresh session opened with it.`,
      `/shake — arm a one-shot context transformer that, on the next request, blanks tool outputs larger than ${messages.formatSize(config.shakeOverBytes)} (shakeOverBytes) with an elided marker plus byte count, and reports the estimated savings.`,
      `Compaction strategy "${config.strategy}": on session_before_compact the supersede strategy blanks all but the newest read result per file and drops tool results over ${messages.formatSize(config.dropOverBytes)} (dropOverBytes) that fall outside the most recent ~${config.keepRecentTokens} tokens (keepRecentTokens); the handler then returns undefined, which chains into pi's native compaction so the remaining, leaner context is summarized normally.`,
      `Preemptive compaction runs ctx.compact() when context usage crosses ${config.preemptPct}% (preemptPct). Context promotion switches to a larger-window model from promotion.ladder at ${config.promotePct}% (promotePct) instead of compacting, and the original model is restored on /handoff or a new session.`,
    ].join("\n");
  }

  private registerEvents(): void {
    const pi = this.pi;

    pi.on("session_start", async (event, ctx) => {
      this.shakeArmed = false;

      try {
        const reason = (event as { reason?: unknown }).reason;

        if (reason === "resume" || !this.originalModel) {
          return;
        }

        await this.restoreOriginalModel(ctx);
      } catch {
        return;
      }
    });

    pi.on("context", async (event, ctx) => {
      if (!this.shakeArmed) {
        return undefined;
      }

      this.shakeArmed = false;

      try {
        const incoming = Array.isArray(event.messages) ? (event.messages as unknown[]) : [];
        const result = this.shake.transformRequest(incoming);

        if (result.count === 0) {
          return undefined;
        }

        if (ctx.hasUI) {
          ctx.ui.notify(
            `/shake elided ${result.count} tool result(s) from this request, saving ~${this.messages.formatSize(result.saved)} (≈${this.shake.tokensFor(result.saved)} tokens)`,
            "info",
          );
        }

        return { messages: result.messages as typeof event.messages };
      } catch {
        return undefined;
      }
    });

    pi.on("session_before_compact", async (event, ctx) => {
      try {
        if (this.config.strategy !== "supersede") {
          return undefined;
        }

        if (event.signal && event.signal.aborted) {
          return undefined;
        }

        const preparation = event.preparation as unknown as Record<string, unknown>;

        if (!isRecord(preparation)) {
          return undefined;
        }

        const summarize = Array.isArray(preparation.messagesToSummarize) ? (preparation.messagesToSummarize as unknown[]) : [];
        const prefix = Array.isArray(preparation.turnPrefixMessages) ? (preparation.turnPrefixMessages as unknown[]) : [];

        if (summarize.length === 0 && prefix.length === 0) {
          return undefined;
        }

        const settings = preparation.settings as { keepRecentTokens?: unknown } | undefined;
        const settingsKeepRecentTokens =
          settings && typeof settings.keepRecentTokens === "number" ? settings.keepRecentTokens : undefined;
        const result = this.supersede.transform({
          summarize,
          prefix,
          branchEntries: Array.isArray(event.branchEntries) ? (event.branchEntries as unknown[]) : [],
          cwd: typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd(),
          settingsKeepRecentTokens,
        });

        if (result.notifyText && ctx.hasUI) {
          ctx.ui.notify(result.notifyText, "info");
        }

        return undefined;
      } catch {
        return undefined;
      }
    });

    pi.on("turn_end", async (_event, ctx) => {
      try {
        const usage = ctx.getContextUsage();
        const current = ctx.model;
        const available = this.availableModels(ctx);
        const now = Date.now();
        const plan = this.coordinator.planPromotion(usage, current, available, now);

        if (plan) {
          await this.applyPromotion(ctx, plan);

          return;
        }

        if (!this.coordinator.shouldPreempt(usage, current, available, now)) {
          return;
        }

        const percent = usage && usage.percent !== null && usage.percent !== undefined ? usage.percent : 0;
        const started = this.coordinator.startPreempt(now, percent);

        if (ctx.hasUI) {
          ctx.ui.notify(`Context at ${started.pct}% (threshold ${started.threshold}%) — compacting preemptively`, "warning");
        }

        ctx.compact({
          onComplete: () => {
            this.coordinator.finishPreempt();
          },
          onError: (error: Error) => {
            this.coordinator.finishPreempt();

            if (ctx.hasUI) {
              ctx.ui.notify(`Preemptive compaction failed: ${error.message}`, "error");
            }
          },
        });
      } catch {
        this.coordinator.finishPreempt();
      }
    });
  }

  private async applyPromotion(ctx: ExtensionContext, plan: PromotionPlan): Promise<void> {
    for (const candidate of plan.candidates) {
      const ok = await this.pi.setModel(candidate as AgentModel);

      if (!ok) {
        continue;
      }

      if (!this.originalModel) {
        this.originalModel = plan.current as AgentModel;
      }

      if (ctx.hasUI) {
        ctx.ui.notify(plan.promotedNotice(candidate), "warning");
      }

      return;
    }

    if (ctx.hasUI) {
      ctx.ui.notify(plan.fallbackNotice, "warning");
    }
  }

  private registerCommands(): void {
    const pi = this.pi;
    const config = this.config;
    const messages = this.messages;
    const shake = this.shake;
    const handoff = this.handoff;

    pi.registerCommand("shake", {
      description: `Strip heavy tool results from the live context: blanks tool outputs over ${messages.formatSize(config.shakeOverBytes)} on the next request and reports estimated savings`,
      handler: async (_args, ctx) => {
        const branch = ctx.sessionManager.getBranch() as unknown[];
        const estimate = shake.estimateLiveBranch(branch);

        if (estimate.count === 0) {
          if (ctx.hasUI) {
            ctx.ui.notify(`Nothing to shake: no tool results over ${messages.formatSize(config.shakeOverBytes)} in the live context`, "info");
          }

          return;
        }

        this.shakeArmed = true;

        if (ctx.hasUI) {
          ctx.ui.notify(
            `Shake armed: the next request will elide ${estimate.count} tool result(s) over ${messages.formatSize(config.shakeOverBytes)}, estimated savings ~${messages.formatSize(estimate.bytes)} (≈${shake.tokensFor(estimate.bytes)} tokens)`,
            "info",
          );
        }
      },
    });

    pi.registerCommand("handoff", {
      description: `Write a handoff document to ${config.handoffPath} and optionally start a fresh session from it; run "/handoff help" for strategy details (supersede returns undefined to chain into native compaction)`,
      handler: async (args, ctx) => {
        const instructions = args.trim();

        if (instructions === "help" || instructions === "--help") {
          if (ctx.hasUI) {
            ctx.ui.notify(this.helpText(), "info");
          }

          return;
        }

        const model = ctx.model;

        if (!model) {
          if (ctx.hasUI) {
            ctx.ui.notify("No model selected; cannot generate a handoff document", "error");
          }

          return;
        }

        const branch = ctx.sessionManager.getBranch() as unknown[];
        const serialized = handoff.serializeRecentEntries(branch, config.handoffChars);

        if (!serialized) {
          if (ctx.hasUI) {
            ctx.ui.notify("Nothing to hand off: the session has no conversation yet", "warning");
          }

          return;
        }

        const sessionFile = ctx.sessionManager.getSessionFile();
        const prompt = handoff.buildPrompt(serialized, instructions);
        let doc = "";

        if (ctx.hasUI) {
          ctx.ui.setStatus("compaction", "generating handoff document");
        }

        try {
          const auth = await this.resolveAuth(ctx, model);
          const response = await complete(
            model,
            {
              systemPrompt: HANDOFFSYSTEM,
              messages: [
                {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: prompt }],
                  timestamp: Date.now(),
                },
              ],
            },
            {
              apiKey: auth.apiKey,
              headers: auth.headers,
              maxTokens: config.handoffMaxTokens,
              signal: ctx.signal,
            },
          );

          if (response.stopReason === "aborted") {
            if (ctx.hasUI) {
              ctx.ui.notify("Handoff generation cancelled", "info");
            }

            return;
          }

          if (response.stopReason === "error") {
            throw new Error(response.errorMessage || "model returned an error");
          }

          doc = handoff.extractText(response.content);

          if (!doc) {
            throw new Error("model returned an empty handoff document");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          if (ctx.hasUI) {
            ctx.ui.notify(`Handoff generation failed: ${message}`, "error");
          }

          return;
        } finally {
          if (ctx.hasUI) {
            ctx.ui.setStatus("compaction", undefined);
          }
        }

        const target = isAbsolute(config.handoffPath) ? config.handoffPath : resolve(ctx.cwd, config.handoffPath);

        try {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, `${doc}\n`, "utf8");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          if (ctx.hasUI) {
            ctx.ui.notify(`Failed to write ${target}: ${message}`, "error");
          }

          return;
        }

        await this.restoreOriginalModel(ctx);

        if (!ctx.hasUI) {
          return;
        }

        ctx.ui.notify(`Handoff document written to ${config.handoffPath}`, "info");

        const startFresh = await ctx.ui.confirm(
          "Handoff written",
          `Start a fresh session opened with ${config.handoffPath} as its first context?`,
        );

        if (!startFresh) {
          return;
        }

        const opening = handoff.openingText(config.handoffPath, doc);
        let seeded = false;
        const result = await ctx.newSession({
          parentSession: sessionFile,
          setup: async (sessionManager) => {
            const manager = sessionManager as unknown as SessionManagerSurface;

            if (typeof manager.appendMessage === "function") {
              manager.appendMessage({
                role: "user",
                content: [{ type: "text", text: opening }],
                timestamp: Date.now(),
              });
              seeded = true;
            }
          },
          withSession: async (fresh) => {
            if (seeded) {
              fresh.ui.notify("Fresh session started with the handoff document as opening context", "info");

              return;
            }

            fresh.ui.setEditorText(opening);
            fresh.ui.notify("Fresh session started; handoff document placed in the editor — submit to seed the context", "info");
          },
        });

        if (result.cancelled) {
          ctx.ui.notify("New session cancelled; handoff document is still saved", "info");
        }
      },
    });
  }
}
