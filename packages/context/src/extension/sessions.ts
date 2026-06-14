import { completeSimple, StringEnum } from "@earendil-works/pi-ai";
import type { Context, ThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Btw, BTW_SYSTEM, Search } from "../sessions/search.ts";
import type { ResolvedAuth } from "../sessions/search.ts";
import { Store } from "../sessions/index.ts";
import { Text } from "../sessions/text.ts";
import type { SessionsConfig } from "../sessions/text.ts";
import type { SearchHit } from "../sessions/transcript.ts";
import { Viewer } from "./viewer.ts";

interface HistoryArgs {
  op: "list" | "read" | "search" | "info";
  all?: boolean;
  session?: string;
  offset?: number;
  limit?: number;
  query?: string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown> | undefined;
}

export class SessionsRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: SessionsConfig;
  private readonly store: Store;
  private readonly search: Search;
  private readonly viewer: Viewer;

  constructor(pi: ExtensionAPI, config: SessionsConfig, store: Store, search: Search, viewer: Viewer) {
    this.pi = pi;
    this.config = config;
    this.store = store;
    this.search = search;
    this.viewer = viewer;
  }

  register(): void {
    this.registerHistory();
    this.registerSearch();
    this.registerBtw();
  }

  private historyParameters(): ReturnType<typeof Type.Object> {
    return Type.Object({
      op: StringEnum(["list", "read", "search", "info"], {
        description:
          "list recent sessions, read one session transcript, search transcripts for literal text, or show info about the current session",
      }),
      all: Type.Optional(Type.Boolean({ description: "for list and search: include sessions from every project, not just the current one" })),
      session: Type.Optional(Type.String({ description: "for read: session id, unique id prefix, or session file path" })),
      offset: Type.Optional(Type.Number({ description: "for read: transcript item index to start from; defaults to the tail of the transcript" })),
      limit: Type.Optional(Type.Number({ description: `for read: maximum transcript items to return (default ${this.config.readLimit})` })),
      query: Type.Optional(Type.String({ description: "for search: literal text to find, matched case-insensitively" })),
    });
  }

  private historyDescription(): string {
    return `Inspect saved pi sessions. Ops: list (recent sessions for this project with id, date, name, and message count; all:true for every project), read (a readable transcript slice of one session: roles plus text, tool calls as one-line summaries; session required, offset/limit optional and default to the tail), search (case-insensitive literal scan across saved transcripts; query required, all:true widens scope, capped at ${this.config.searchLimit} matches), info (current session file path, entry count, and branch depth).`;
  }

  private registerHistory(): void {
    this.pi.registerTool({
      name: "history",
      label: "History",
      description: this.historyDescription(),
      parameters: this.historyParameters(),
      execute: (
        _toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ): Promise<ToolResult> => this.runHistory(params, signal, ctx),
    });
  }

  private async runHistory(params: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult> {
    const args = params as HistoryArgs;

    if (signal?.aborted) {
      throw new Error("history: aborted");
    }

    this.store.clearCache();

    switch (args.op) {
      case "list":
        return this.historyList(args, ctx);

      case "read":
        return this.historyRead(args, ctx);

      case "search":
        return this.historySearch(args, signal, ctx);

      case "info":
        return this.historyInfo(ctx);

      default:
        throw new Error(`unknown op "${String(args.op)}"`);
    }
  }

  private async historyList(args: HistoryArgs, ctx: ExtensionContext): Promise<ToolResult> {
    const all = args.all === true;
    const sessions = await this.store.listSessions(ctx.cwd, all);
    const shown = sessions.slice(0, this.config.listLimit);

    return {
      content: [{ type: "text", text: Search.listText(sessions, all, ctx.cwd, this.config.listLimit, this.sessionFileOf(ctx)) }],
      details: { total: sessions.length, sessions: shown },
    };
  }

  private async historyRead(args: HistoryArgs, ctx: ExtensionContext): Promise<ToolResult> {
    if (typeof args.session !== "string" || args.session.trim() === "") {
      throw new Error('op "read" requires a session id or file path');
    }

    const path = await this.store.resolveSession(args.session, ctx.cwd);
    const transcript = this.store.loadTranscript(path);
    const total = transcript.items.length;

    if (total === 0) {
      return {
        content: [{ type: "text", text: `Session ${path} has no readable transcript entries.` }],
        details: { path, total: 0 },
      };
    }

    const limit = Text.clampInt(args.limit, 1, 500, this.config.readLimit);
    const offset =
      args.offset !== undefined ? Text.clampInt(args.offset, 0, Math.max(0, total - 1), 0) : Math.max(0, total - limit);

    return {
      content: [{ type: "text", text: Search.readText(path, transcript, offset, limit) }],
      details: { path, sessionId: transcript.id, total, offset, limit },
    };
  }

  private async historySearch(args: HistoryArgs, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<ToolResult> {
    if (typeof args.query !== "string" || args.query.trim() === "") {
      throw new Error('op "search" requires a non-empty query');
    }

    const all = args.all === true;
    const query = args.query.trim();
    const sessions = await this.store.listSessions(ctx.cwd, all);
    const hits = this.search.searchSessions(query, sessions, this.config.searchLimit, this.config.excerptChars, signal);

    return {
      content: [{ type: "text", text: Search.searchText(query, hits, this.config.searchLimit, all) }],
      details: { query, all, hits },
    };
  }

  private historyInfo(ctx: ExtensionContext): ToolResult {
    const file = this.sessionFileOf(ctx);
    let entryCount = 0;
    let branchDepth = 0;
    let leaf = "";

    try {
      const entries: unknown = ctx.sessionManager.getEntries();

      if (Array.isArray(entries)) {
        entryCount = entries.length;
      }
    } catch {
      entryCount = 0;
    }

    try {
      const branch: unknown = ctx.sessionManager.getBranch();

      if (Array.isArray(branch)) {
        branchDepth = branch.length;
      }
    } catch {
      branchDepth = 0;
    }

    try {
      const leafId: unknown = ctx.sessionManager.getLeafId();

      if (typeof leafId === "string") {
        leaf = leafId;
      }
    } catch {
      leaf = "";
    }

    let name = "";

    try {
      const sessionName: unknown = this.pi.getSessionName();

      if (typeof sessionName === "string") {
        name = sessionName;
      }
    } catch {
      name = "";
    }

    const lines = [
      `session file: ${file === "" ? "(in-memory, not persisted)" : file}`,
      `entries: ${entryCount}`,
      `branch depth: ${branchDepth}`,
      `leaf entry: ${leaf === "" ? "(none)" : leaf}`,
      `name: ${name === "" ? "(unset)" : name}`,
      `project: ${ctx.cwd}`,
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { file, entryCount, branchDepth, leaf, name },
    };
  }

  private sessionFileOf(ctx: ExtensionContext | ExtensionCommandContext): string {
    try {
      const file: unknown = ctx.sessionManager.getSessionFile();

      return typeof file === "string" ? file : "";
    } catch {
      return "";
    }
  }

  private registerSearch(): void {
    this.pi.registerCommand("search", {
      description: 'Search saved session transcripts for literal text; add "--all" to include every project',
      handler: (args: string, ctx: ExtensionCommandContext): Promise<void> => this.runSearch(args, ctx),
    });
  }

  private async runSearch(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    let query = (rawArgs ?? "").trim();
    let all = false;

    if (/(^|\s)--all(\s|$)/.test(query)) {
      all = true;
      query = query.replace(/(^|\s)--all(\s|$)/g, " ").trim();
    }

    if (query === "" && ctx.mode === "tui" && ctx.hasUI) {
      const asked = await ctx.ui.input("Search sessions", "literal text to find");
      query = (asked ?? "").trim();
    }

    if (query === "") {
      this.viewer.notify(ctx, "Usage: /search <query> [--all]", "warning");
      return;
    }

    this.store.clearCache();

    if (ctx.hasUI) {
      try {
        ctx.ui.setStatus("sessions", `searching for "${Text.oneLine(query, 32)}"…`);
      } catch {
        void 0;
      }
    }

    let hits: SearchHit[] = [];

    try {
      const sessions = await this.store.listSessions(ctx.cwd, all);
      hits = this.search.searchSessions(query, sessions, this.config.searchLimit, this.config.excerptChars, ctx.signal);
    } catch (error) {
      this.viewer.notify(ctx, `search: ${Text.describeError(error)}`, "error");
      return;
    } finally {
      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus("sessions", undefined);
        } catch {
          void 0;
        }
      }
    }

    if (hits.length === 0) {
      this.viewer.notify(ctx, `No matches for "${query}"${all ? "" : ' (add "--all" to search every project)'}.`, "info");
      return;
    }

    if (ctx.mode !== "tui" || !ctx.hasUI) {
      console.log(Search.formatHits(query, hits, this.config.searchLimit));
      return;
    }

    const options = hits.map((hit, index) =>
      Text.oneLine(`${index + 1}. ${Text.formatStamp(hit.modified)}  ${hit.sessionTitle} · ${hit.excerpt}`, 110),
    );

    for (;;) {
      const choice = await ctx.ui.select(`${hits.length} matches for "${Text.oneLine(query, 40)}" — open one`, options);

      if (choice === undefined) {
        return;
      }

      const picked = hits[Number.parseInt(choice, 10) - 1];

      if (!picked) {
        return;
      }

      let contextText: string;

      try {
        contextText = this.search.contextFor(picked, this.config.contextEntries);
      } catch (error) {
        this.viewer.notify(ctx, `search: ${Text.describeError(error)}`, "error");
        return;
      }

      await this.viewer.showText(
        ctx,
        `${picked.sessionId.slice(0, 8)} · ${Text.formatStamp(picked.modified)} · ${picked.sessionTitle}`,
        contextText,
      );

      if (this.config.allowSwitch) {
        const switched = await this.offerSwitch(ctx, picked);

        if (switched) {
          return;
        }
      }
    }
  }

  private async offerSwitch(ctx: ExtensionCommandContext, hit: SearchHit): Promise<boolean> {
    if (hit.path === this.sessionFileOf(ctx)) {
      return false;
    }

    const go = await ctx.ui.confirm(
      "Switch session",
      `Switch to ${hit.path}? The current session will be left as-is and this one opened in its place.`,
    );

    if (!go) {
      return false;
    }

    try {
      await ctx.switchSession(hit.path, {});
      return true;
    } catch (error) {
      this.viewer.notify(ctx, `search: could not switch session: ${Text.describeError(error)}`, "error");
      return false;
    }
  }

  private registerBtw(): void {
    this.pi.registerCommand("btw", {
      description: "Ask the current model a side question with conversation context, without writing anything to the session",
      handler: (args: string, ctx: ExtensionCommandContext): Promise<void> => this.runBtw(args, ctx),
    });
  }

  private async runBtw(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    let question = (rawArgs ?? "").trim();

    if (question === "" && ctx.mode === "tui" && ctx.hasUI) {
      const asked = await ctx.ui.input("btw", "side question about this conversation");
      question = (asked ?? "").trim();
    }

    if (question === "") {
      this.viewer.notify(ctx, "Usage: /btw <question>", "warning");
      return;
    }

    const model = ctx.model;

    if (!model) {
      this.viewer.notify(ctx, "btw: no model is selected", "error");
      return;
    }

    if (ctx.signal?.aborted) {
      return;
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    const tui = ctx.mode === "tui" && ctx.hasUI;
    const setSpinner = (text: string | undefined): void => {
      if (!tui) {
        return;
      }

      try {
        if (text === undefined) {
          ctx.ui.setWorkingMessage();
        } else {
          ctx.ui.setWorkingMessage(text);
        }
      } catch {
        void 0;
      }
    };

    setSpinner(`btw: asking ${model.name || model.id}…`);

    try {
      const transcript = Btw.branchTranscript(this.branchEntries(ctx), this.config.btwBudget);
      const message: UserMessage = {
        role: "user",
        content: Btw.userMessage(transcript, question),
        timestamp: Date.now(),
      };
      const request: Context = { systemPrompt: BTW_SYSTEM, messages: [message] };
      const auth = Btw.resolveAuth(await this.lookupAuth(ctx));
      const maxTokens = Btw.resolveMaxTokens(model.maxTokens, this.config.btwMaxTokens);

      let reasoning: ThinkingLevel | undefined;

      try {
        reasoning = Btw.resolveReasoning(model.reasoning, this.pi.getThinkingLevel()) as ThinkingLevel | undefined;
      } catch {
        reasoning = undefined;
      }

      const response = await completeSimple(model, request, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens,
        reasoning,
        signal: controller.signal,
      });

      setSpinner(undefined);

      if (response.stopReason === "aborted") {
        this.viewer.notify(ctx, "btw: cancelled", "warning");
        return;
      }

      if (response.stopReason === "error") {
        throw new Error(
          response.errorMessage && response.errorMessage !== "" ? response.errorMessage : "the provider returned an error",
        );
      }

      const answer = Btw.plainText(response.content).trim();
      await this.viewer.showText(ctx, `btw · ${model.id}`, answer === "" ? "(the model returned no text)" : answer);
    } catch (error) {
      if (controller.signal.aborted) {
        this.viewer.notify(ctx, "btw: cancelled", "warning");
        return;
      }

      this.viewer.notify(ctx, `btw: ${Text.describeError(error)}`, "error");
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
      setSpinner(undefined);
    }
  }

  private async lookupAuth(ctx: ExtensionCommandContext): Promise<ResolvedAuth | unknown> {
    const registry: unknown = ctx.modelRegistry;

    if (!Text.isRecord(registry) || typeof registry.getApiKeyAndHeaders !== "function") {
      return {};
    }

    const lookup = registry.getApiKeyAndHeaders as (model: unknown) => Promise<unknown>;

    return lookup.call(registry, ctx.model);
  }

  private branchEntries(ctx: ExtensionCommandContext): unknown[] {
    try {
      const branch: unknown = ctx.sessionManager.getBranch();

      if (Array.isArray(branch)) {
        return branch;
      }
    } catch {
      void 0;
    }

    try {
      const entries: unknown = ctx.sessionManager.getEntries();

      if (Array.isArray(entries)) {
        return entries;
      }
    } catch {
      void 0;
    }

    return [];
  }
}
