import { completeSimple, StringEnum, type Api, type Model, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { MemoryConfig, Store } from "../memory/index.ts";
import type { BranchEntry, Consolidator, ConsolidationResult, SessionEntry } from "../memory/consolidate.ts";
import { MemoryInjector } from "../memory/inject.ts";

function notify(ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, kind);
  }
}

export class MemoryRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly cfg: MemoryConfig;
  private readonly store: Store;
  private readonly consolidator: Consolidator;
  private readonly injector = new MemoryInjector();
  private running = false;

  constructor(pi: ExtensionAPI, cfg: MemoryConfig, store: Store, consolidator: Consolidator) {
    this.pi = pi;
    this.cfg = cfg;
    this.store = store;
    this.consolidator = consolidator;
  }

  register(): void {
    this.registerTool();
    this.registerCommand();
    this.registerEvents();
  }

  private resolveModel(ctx: ExtensionContext): Model<Api> | undefined {
    const wanted = this.cfg.model.trim();

    if (wanted.length > 0) {
      const split = wanted.indexOf("/");

      if (split > 0) {
        const found = ctx.modelRegistry.find(wanted.slice(0, split), wanted.slice(split + 1));

        if (found) {
          return found;
        }
      }

      try {
        const byId = ctx.modelRegistry.getAll().find((model) => model.id === wanted);

        if (byId) {
          return byId;
        }
      } catch {}
    }

    return ctx.model ?? undefined;
  }

  run = async (ctx: ExtensionContext, signal?: AbortSignal): Promise<ConsolidationResult> => {
    if (this.running) {
      return { saved: 0, reason: "consolidation already running" };
    }

    this.running = true;

    try {
      let branch: readonly BranchEntry[] = [];

      try {
        branch = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
      } catch {
        branch = [];
      }

      const collected = this.consolidator.collect(branch, this.consolidator.cursor, this.cfg.transcriptBudget);
      const skip = this.consolidator.skipReason(collected.transcript, collected.lastId);

      if (skip !== undefined) {
        return { saved: 0, reason: skip };
      }

      const model = this.resolveModel(ctx);

      if (!model) {
        return { saved: 0, reason: "no model available" };
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);

      if (!auth.ok) {
        return { saved: 0, reason: auth.error };
      }

      const response = await completeSimple(
        model,
        {
          systemPrompt: this.consolidator.extractionPrompt(this.cfg.maxFacts),
          messages: [{ role: "user", content: `Session excerpt:\n\n${collected.transcript}`, timestamp: Date.now() }],
        },
        { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 1024, temperature: 0, signal },
      );

      if (response.stopReason === "error" || response.stopReason === "aborted") {
        return { saved: 0, reason: response.errorMessage ?? "model call failed" };
      }

      const raw = response.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const plan = this.consolidator.runPlan(collected.transcript, collected.lastId, raw, this.cfg.maxFacts);

      if (plan.skip) {
        return { saved: 0, reason: plan.reason };
      }

      const dir = this.store.memoryDir(ctx.cwd);
      let saved = 0;

      for (const fact of plan.facts) {
        try {
          const existing = await this.store.readTopic(dir, fact.topic);

          if (existing !== undefined && existing.includes(fact.text)) {
            continue;
          }

          await this.store.saveTopic(dir, fact.topic, fact.text, this.cfg.maxTopicBytes);
          saved += 1;
        } catch {}
      }

      this.consolidator.markConsolidated(collected.transcript, collected.lastId);

      try {
        this.pi.appendEntry("memory.cursor", { entryId: collected.lastId });
      } catch {}

      return { saved, reason: saved === 0 ? "no durable facts found" : "" };
    } catch {
      return { saved: 0, reason: "consolidation failed" };
    } finally {
      this.running = false;
    }
  };

  private registerTool(): void {
    const store = this.store;
    const cfg = this.cfg;

    this.pi.registerTool({
      name: "memory",
      label: "Memory",
      description:
        'Persistent cross-session project memory stored under ~/.pi/agent/memory. Ops: "save" appends a durable fact to a topic file and updates the index (requires topic and text); "recall" returns the index plus the full body of one topic (topic optional: omit it to get just the index); "list" shows all topics; "forget" deletes a topic (requires topic). Save stable project facts, explicit user preferences, and hard-won gotchas. Never save source code or anything git already tracks.',
      parameters: Type.Object({
        op: StringEnum(["save", "recall", "list", "forget"], { description: "Memory operation to perform" }),
        topic: Type.Optional(
          Type.String({ description: "Topic name, a short noun phrase; required for save and forget, optional for recall" }),
        ),
        text: Type.Optional(Type.String({ description: "Fact text to store; required for save" })),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const dir = store.memoryDir(ctx.cwd);
        const topic = params.topic?.trim() ?? "";

        if (params.op === "save") {
          const text = params.text?.trim() ?? "";

          if (topic.length === 0) {
            throw new Error('memory op "save" requires a topic');
          }

          if (text.length === 0) {
            throw new Error('memory op "save" requires text');
          }

          const result = await store.saveTopic(dir, topic, text, cfg.maxTopicBytes);

          return {
            content: [
              { type: "text", text: `${result.created ? "Created" : "Updated"} memory topic "${result.slug}" (${result.file})` },
            ],
            details: result,
          };
        }

        if (params.op === "recall") {
          const index = (await store.readIndex(dir)).trim();

          if (topic.length === 0) {
            const text =
              index.length > 0 ? `Memory index:\n${store.clip(index, cfg.recallBudget)}` : "No memories saved for this project yet.";

            return { content: [{ type: "text", text }], details: undefined };
          }

          const body = await store.readTopic(dir, topic);

          if (body === undefined) {
            throw new Error(`No memory topic matches "${topic}"; use op "list" to see available topics`);
          }

          const indexPart = index.length > 0 ? `Memory index:\n${store.clip(index, 1000)}\n\n` : "";

          return {
            content: [{ type: "text", text: `${indexPart}Topic "${topic}":\n${store.clip(body.trim(), cfg.recallBudget)}` }],
            details: undefined,
          };
        }

        if (params.op === "list") {
          const topics = await store.listTopics(dir);
          const text =
            topics.length === 0
              ? "No memories saved for this project yet."
              : topics.map((ref) => `${ref.slug}${ref.summary.length > 0 ? ` — ${ref.summary}` : ""}`).join("\n");

          return { content: [{ type: "text", text }], details: { topics } };
        }

        if (topic.length === 0) {
          throw new Error('memory op "forget" requires a topic');
        }

        const removed = await store.forgetTopic(dir, topic);

        if (!removed) {
          throw new Error(`No memory topic matches "${topic}"`);
        }

        return { content: [{ type: "text", text: `Forgot memory topic "${topic}"` }], details: undefined };
      },
    });
  }

  private registerCommand(): void {
    const store = this.store;
    const run = this.run;

    this.pi.registerCommand("memory", {
      description: "Show project memory index; subcommands: open <topic>, forget <topic>, consolidate",
      getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
        const subs: AutocompleteItem[] = [
          { value: "open", label: "open", description: "Show a memory topic" },
          { value: "forget", label: "forget", description: "Delete a memory topic" },
          { value: "consolidate", label: "consolidate", description: "Extract durable facts from this session now" },
        ];
        const parts = prefix.split(/\s+/).filter((part) => part.length > 0);
        const trailing = /\s$/.test(prefix);

        if (parts.length === 0) {
          return subs;
        }

        if (parts.length === 1 && !trailing) {
          const matches = subs.filter((sub) => sub.value.startsWith(parts[0]));

          return matches.length > 0 ? matches : null;
        }

        const sub = parts[0];

        if (sub !== "open" && sub !== "forget") {
          return null;
        }

        const topicPrefix = trailing ? "" : parts.slice(1).join(" ");
        let topics;

        try {
          topics = await store.listTopics(store.memoryDir(process.cwd()));
        } catch {
          return null;
        }

        const items = topics
          .filter(
            (ref) => ref.slug.startsWith(topicPrefix) || ref.title.toLowerCase().startsWith(topicPrefix.toLowerCase()),
          )
          .map((ref) => ({
            value: `${sub} ${ref.slug}`,
            label: ref.slug,
            description: ref.summary.length > 0 ? ref.summary : ref.title,
          }));

        return items.length > 0 ? items : null;
      },
      handler: async (args, ctx) => {
        const dir = store.memoryDir(ctx.cwd);
        const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
        const sub = parts[0] ?? "";
        const rest = parts.slice(1).join(" ");

        if (sub === "") {
          const index = (await store.readIndex(dir)).trim();
          notify(
            ctx,
            index.length > 0 ? `Memory index (${dir}):\n${store.clip(index, 4000)}` : "No memories saved for this project yet.",
            "info",
          );

          return;
        }

        if (sub === "open") {
          if (rest.length === 0) {
            notify(ctx, "Usage: /memory open <topic>", "warning");

            return;
          }

          const body = await store.readTopic(dir, rest);

          if (body === undefined) {
            notify(ctx, `No memory topic matches "${rest}"`, "warning");

            return;
          }

          notify(ctx, store.clip(body.trim(), 4000), "info");

          return;
        }

        if (sub === "forget") {
          if (rest.length === 0) {
            notify(ctx, "Usage: /memory forget <topic>", "warning");

            return;
          }

          if (ctx.hasUI) {
            const confirmed = await ctx.ui.confirm("Forget memory", `Delete memory topic "${rest}"?`);

            if (!confirmed) {
              return;
            }
          }

          const removed = await store.forgetTopic(dir, rest);
          notify(ctx, removed ? `Forgot memory topic "${rest}"` : `No memory topic matches "${rest}"`, removed ? "info" : "warning");

          return;
        }

        if (sub === "consolidate") {
          notify(ctx, "Consolidating session memory…", "info");
          const result = await run(ctx);
          const summary =
            result.saved > 0
              ? `Saved ${result.saved} memory ${result.saved === 1 ? "fact" : "facts"}`
              : `No memories saved${result.reason.length > 0 ? ` (${result.reason})` : ""}`;
          notify(ctx, summary, "info");

          return;
        }

        notify(ctx, `Unknown subcommand "${sub}". Usage: /memory [open <topic> | forget <topic> | consolidate]`, "warning");
      },
    });
  }

  private registerEvents(): void {
    const pi = this.pi;
    const cfg = this.cfg;
    const store = this.store;
    const consolidator = this.consolidator;
    const injector = this.injector;

    pi.on("before_agent_start", async (event, ctx) => {
      const index = await store.readIndex(store.memoryDir(ctx.cwd));
      const systemPrompt = injector.suffix(event.systemPrompt, index, cfg.injectBudget);

      if (systemPrompt === undefined) {
        return undefined;
      }

      return { systemPrompt };
    });

    pi.on("session_start", (_event, ctx) => {
      consolidator.restore(ctx.sessionManager.getEntries() as unknown as SessionEntry[]);
    });

    pi.on("turn_end", () => {
      consolidator.bumpTurn();
    });

    pi.on("agent_end", (_event, ctx) => {
      if (cfg.consolidateEvery <= 0 || consolidator.turns < cfg.consolidateEvery) {
        return;
      }

      consolidator.resetTurns();
      void this.run(ctx).catch(() => undefined);
    });

    pi.on("session_shutdown", async (event, ctx) => {
      if (event.reason !== "quit" || !cfg.consolidateOnQuit) {
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);

      try {
        await this.run(ctx, controller.signal);
      } catch {
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
