import { completeSimple, type Api, type Model, type TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clip, memoryDir, readTopic, saveTopic, slugify, type MemoryConfig } from "./store";

export interface ConsolidationResult {
  saved: number;
  reason: string;
}

interface Fact {
  topic: string;
  text: string;
}

interface BranchEntry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
}

const CURSOR_TYPE = "memory.cursor";

function tailClip(text: string, budget: number): string {
  if (budget <= 0 || text.length <= budget) return text;
  const slice = text.slice(text.length - budget);
  const cut = slice.indexOf("\n");
  return cut >= 0 && cut < slice.length - 1 ? slice.slice(cut + 1) : slice;
}

function partText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function messageLine(message: unknown, budget: number): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const role = (message as { role?: unknown }).role;
  const text = partText((message as { content?: unknown }).content).trim();
  if (text.length === 0) return undefined;
  if (role === "user") return `User: ${clip(text, budget)}`;
  if (role === "assistant") return `Assistant: ${clip(text, budget)}`;
  if (role === "toolResult" && (message as { isError?: unknown }).isError === true) {
    const tool = typeof (message as { toolName?: unknown }).toolName === "string" ? (message as { toolName: string }).toolName : "tool";
    return `Tool error (${tool}): ${clip(text, budget)}`;
  }
  return undefined;
}

function collect(ctx: ExtensionContext, cursor: string | null, budget: number): { transcript: string; lastId: string | null } {
  let entries: BranchEntry[];
  try {
    entries = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
  } catch {
    return { transcript: "", lastId: null };
  }
  let start = 0;
  if (cursor !== null) {
    const at = entries.findIndex((entry) => entry.id === cursor);
    if (at >= 0) start = at + 1;
  }
  const lines: string[] = [];
  let lastId: string | null = null;
  for (let i = start; i < entries.length; i += 1) {
    const entry = entries[i];
    lastId = entry.id;
    if (entry.type !== "message") continue;
    const line = messageLine(entry.message, 600);
    if (line !== undefined) lines.push(line);
  }
  return { transcript: tailClip(lines.join("\n\n"), budget), lastId };
}

function resolveModel(ctx: ExtensionContext, cfg: MemoryConfig): Model<Api> | undefined {
  const wanted = cfg.model.trim();
  if (wanted.length > 0) {
    const split = wanted.indexOf("/");
    if (split > 0) {
      const found = ctx.modelRegistry.find(wanted.slice(0, split), wanted.slice(split + 1));
      if (found) return found;
    }
    try {
      const byId = ctx.modelRegistry.getAll().find((model) => model.id === wanted);
      if (byId) return byId;
    } catch {}
  }
  return ctx.model ?? undefined;
}

function extractionPrompt(maxFacts: number): string {
  return [
    "You maintain long-term memory for a coding agent working in one project.",
    `Read the session excerpt and extract at most ${maxFacts} durable facts genuinely worth remembering in future sessions.`,
    "Durable facts are: stable project facts (build, test, and run commands, architecture decisions, environment quirks), explicit user preferences, and hard-won gotchas that cost real effort to discover.",
    "Never record source code or file contents that git already tracks, transient task state, in-progress work, or anything specific to this single session.",
    'Respond with a JSON array only, no prose, no code fences. Each element must be {"topic": "<short noun phrase>", "text": "<one to three plain sentences>"}.',
    "If nothing qualifies, respond with [].",
  ].join("\n");
}

function parseFacts(raw: string, maxFacts: number): Fact[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const facts: Fact[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (facts.length >= maxFacts) break;
    if (item === null || typeof item !== "object") continue;
    const topic = typeof (item as { topic?: unknown }).topic === "string" ? (item as { topic: string }).topic.trim() : "";
    const text = typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text.trim() : "";
    if (topic.length === 0 || text.length === 0) continue;
    const slug = slugify(topic);
    if (seen.has(slug)) continue;
    seen.add(slug);
    facts.push({ topic, text });
  }
  return facts;
}

export function registerConsolidation(
  pi: ExtensionAPI,
  cfg: MemoryConfig,
): (ctx: ExtensionContext, signal?: AbortSignal) => Promise<ConsolidationResult> {
  let cursor: string | null = null;
  let turns = 0;
  let running = false;

  const restore = (ctx: ExtensionContext): void => {
    cursor = null;
    turns = 0;
    try {
      for (const entry of ctx.sessionManager.getEntries() as unknown as BranchEntry[]) {
        if (entry.type !== "custom" || entry.customType !== CURSOR_TYPE) continue;
        const data = entry.data;
        if (data !== null && typeof data === "object" && typeof (data as { entryId?: unknown }).entryId === "string") {
          cursor = (data as { entryId: string }).entryId;
        }
      }
    } catch {
      cursor = null;
    }
  };

  const run = async (ctx: ExtensionContext, signal?: AbortSignal): Promise<ConsolidationResult> => {
    if (running) return { saved: 0, reason: "consolidation already running" };
    running = true;
    try {
      const { transcript, lastId } = collect(ctx, cursor, cfg.transcriptBudget);
      if (lastId === null || transcript.length < 80) return { saved: 0, reason: "nothing new to consolidate" };
      const model = resolveModel(ctx, cfg);
      if (!model) return { saved: 0, reason: "no model available" };
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return { saved: 0, reason: auth.error };
      const response = await completeSimple(
        model,
        {
          systemPrompt: extractionPrompt(cfg.maxFacts),
          messages: [{ role: "user", content: `Session excerpt:\n\n${transcript}`, timestamp: Date.now() }],
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
      const facts = parseFacts(raw, cfg.maxFacts);
      const dir = memoryDir(ctx.cwd);
      let saved = 0;
      for (const fact of facts) {
        try {
          const existing = await readTopic(dir, fact.topic);
          if (existing !== undefined && existing.includes(fact.text)) continue;
          await saveTopic(dir, fact.topic, fact.text, cfg.maxTopicBytes);
          saved += 1;
        } catch {}
      }
      cursor = lastId;
      try {
        pi.appendEntry(CURSOR_TYPE, { entryId: lastId });
      } catch {}
      return { saved, reason: saved === 0 ? "no durable facts found" : "" };
    } catch {
      return { saved: 0, reason: "consolidation failed" };
    } finally {
      running = false;
    }
  };

  pi.on("session_start", (event, ctx) => {
    restore(ctx);
  });

  pi.on("turn_end", () => {
    turns += 1;
  });

  pi.on("agent_end", (event, ctx) => {
    if (cfg.consolidateEvery <= 0) return;
    if (turns < cfg.consolidateEvery) return;
    turns = 0;
    void run(ctx).catch(() => undefined);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "quit" || !cfg.consolidateOnQuit) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      await run(ctx, controller.signal);
    } catch {
    } finally {
      clearTimeout(timer);
    }
  });

  return run;
}
