import { Store } from "./index.ts";
import { Text } from "./text.ts";
import type { SearchHit, SessionSummary, SessionTranscript } from "./transcript.ts";

const OUTPUT_CAP = 45000;

export const BTW_SYSTEM =
  "You are answering a quick side question about an ongoing coding-agent conversation. The user shares a transcript excerpt for context, then asks a question. Answer the question directly and concisely. Do not address the conversation participants, do not continue or roleplay the conversation, and do not propose tool calls or next steps unless the question asks for them.";

export const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export interface ResolvedAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

interface BranchPiece {
  label: string;
  text: string;
}

export class Search {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  searchSessions(
    query: string,
    sessions: SessionSummary[],
    cap: number,
    excerptChars: number,
    signal?: AbortSignal,
  ): SearchHit[] {
    const needle = query.toLowerCase();

    if (needle === "") {
      return [];
    }

    const hits: SearchHit[] = [];

    for (const session of sessions) {
      if (signal?.aborted) {
        break;
      }

      let transcript: SessionTranscript;

      try {
        transcript = this.store.loadTranscript(session.path);
      } catch {
        continue;
      }

      const title = Store.sessionTitle(session);

      for (const item of transcript.items) {
        const at = item.text.toLowerCase().indexOf(needle);

        if (at < 0) {
          continue;
        }

        hits.push({
          path: session.path,
          sessionId: session.id,
          sessionTitle: title,
          modified: session.modified,
          itemIndex: item.index,
          label: item.label,
          excerpt: Search.makeExcerpt(item.text, at, needle.length, excerptChars),
        });

        if (hits.length >= cap) {
          return hits;
        }
      }
    }

    return hits;
  }

  contextFor(hit: SearchHit, span: number): string {
    const transcript = this.store.loadTranscript(hit.path);
    const start = Math.max(0, hit.itemIndex - span);
    const end = Math.min(transcript.items.length, hit.itemIndex + span + 1);
    const parts: string[] = [];

    for (const item of transcript.items.slice(start, end)) {
      const marker = item.index === hit.itemIndex ? "→ " : "";
      parts.push(`${marker}[${item.index}] ${item.label}: ${item.text}`);
    }

    if (parts.length === 0) {
      return "(the matched entry is no longer present in this session file)";
    }

    return parts.join("\n\n");
  }

  static makeExcerpt(text: string, at: number, matchLength: number, excerptChars: number): string {
    const lead = Math.max(0, Math.floor((excerptChars - matchLength) / 3));
    const start = Math.max(0, at - lead);
    const end = Math.min(text.length, start + Math.max(matchLength, excerptChars));
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";

    return `${prefix}${Text.oneLine(text.slice(start, end), excerptChars + matchLength)}${suffix}`;
  }

  static listText(
    sessions: SessionSummary[],
    all: boolean,
    cwd: string,
    limit: number,
    current: string,
  ): string {
    return Format.listText(sessions, all, cwd, limit, current);
  }

  static readText(
    path: string,
    transcript: SessionTranscript,
    offset: number,
    limit: number,
  ): string {
    return Format.readText(path, transcript, offset, limit);
  }

  static searchText(query: string, hits: SearchHit[], cap: number, all: boolean): string {
    return Format.searchText(query, hits, cap, all);
  }

  static formatHits(query: string, hits: SearchHit[], cap: number): string {
    return Format.formatHits(query, hits, cap);
  }
}

export class Format {
  static listText(
    sessions: SessionSummary[],
    all: boolean,
    cwd: string,
    limit: number,
    current: string,
  ): string {
    if (sessions.length === 0) {
      return all
        ? "No saved sessions were found."
        : `No saved sessions were found for ${cwd}. Pass all:true to include other projects.`;
    }

    const shown = sessions.slice(0, limit);
    const lines: string[] = [
      `${sessions.length} session${sessions.length === 1 ? "" : "s"} ${all ? "across all projects" : `for ${cwd}`} (showing ${shown.length}, most recent first; * = current):`,
      "",
    ];

    for (const session of shown) {
      const marker = session.path === current ? "*" : " ";
      lines.push(
        `${marker} ${session.id.slice(0, 8)}  ${Text.formatStamp(session.modified)}  ${String(session.messageCount).padStart(4)} msgs  ${Store.sessionTitle(session)}`,
      );
      lines.push(`    ${session.path}`);
    }

    if (sessions.length > shown.length) {
      lines.push("", `(${sessions.length - shown.length} older sessions not shown)`);
    }

    return lines.join("\n");
  }

  static readText(
    path: string,
    transcript: SessionTranscript,
    offset: number,
    limit: number,
  ): string {
    const total = transcript.items.length;
    const slice = transcript.items.slice(offset, offset + limit);
    const header: string[] = [
      `Transcript of ${path} (session ${transcript.id.slice(0, 8)})`,
      `Items ${offset}-${offset + slice.length - 1} of ${total}.`,
    ];

    if (offset > 0) {
      header.push(`Earlier items exist; re-run with offset:${Math.max(0, offset - limit)}.`);
    }

    if (offset + slice.length < total) {
      header.push(`Later items exist; re-run with offset:${offset + slice.length}.`);
    }

    const parts: string[] = [header.join("\n")];
    let used = parts[0].length;

    for (const item of slice) {
      const rendered = `[${item.index}] ${item.label}: ${item.text}`;

      if (used + rendered.length > OUTPUT_CAP) {
        parts.push(`(output truncated for size; continue with offset:${item.index})`);
        break;
      }

      parts.push(rendered);
      used += rendered.length + 2;
    }

    return parts.join("\n\n");
  }

  static searchText(query: string, hits: SearchHit[], cap: number, all: boolean): string {
    if (hits.length === 0) {
      return `No matches for "${query}"${all ? "" : "; pass all:true to search every project"}.`;
    }

    return `${Format.formatHits(query, hits, cap)}\n\n${'Read surrounding context with history op:"read", session:"<id>", offset:<item index>.'}`;
  }

  static formatHits(query: string, hits: SearchHit[], cap: number): string {
    const sessionCount = new Set(hits.map((hit) => hit.path)).size;
    const lines: string[] = [
      `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}" in ${sessionCount} session${sessionCount === 1 ? "" : "s"}${hits.length >= cap ? ` (capped at ${cap})` : ""}:`,
    ];
    let lastPath = "";

    for (const hit of hits) {
      if (hit.path !== lastPath) {
        lastPath = hit.path;
        lines.push(
          "",
          `${hit.sessionId.slice(0, 8)}  ${Text.formatStamp(hit.modified)}  ${hit.sessionTitle}`,
          `  ${hit.path}`,
        );
      }

      lines.push(`  [${hit.itemIndex} ${hit.label}] ${hit.excerpt}`);
    }

    return lines.join("\n");
  }
}

export class Btw {
  static plainText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    const parts: string[] = [];

    for (const block of content) {
      if (Text.isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }

    return parts.join("\n");
  }

  static pieceFrom(entry: unknown): BranchPiece | undefined {
    if (!Text.isRecord(entry) || entry.type !== "message" || !Text.isRecord(entry.message)) {
      return undefined;
    }

    const message = entry.message;

    if (message.role !== "user" && message.role !== "assistant") {
      return undefined;
    }

    const text = Btw.plainText(message.content).trim();

    if (text === "") {
      return undefined;
    }

    return { label: message.role === "user" ? "User" : "Assistant", text };
  }

  static branchTranscript(entries: unknown[], budget: number): string {
    const picked: string[] = [];
    let used = 0;

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const piece = Btw.pieceFrom(entries[index]);

      if (piece === undefined) {
        continue;
      }

      const rendered = `${piece.label}: ${piece.text}`;

      if (used + rendered.length > budget) {
        if (picked.length === 0) {
          const room = Math.max(1, budget - piece.label.length - 3);
          picked.push(`${piece.label}: …${piece.text.slice(Math.max(0, piece.text.length - room))}`);
        }

        break;
      }

      picked.push(rendered);
      used += rendered.length + 2;
    }

    picked.reverse();

    return picked.join("\n\n");
  }

  static intro(transcript: string): string {
    if (transcript === "") {
      return "There is no prior conversation in this session.";
    }

    return `Conversation transcript (oldest first, truncated to fit):\n\n${transcript}`;
  }

  static userMessage(transcript: string, question: string): string {
    return `${Btw.intro(transcript)}\n\nSide question:\n${question}`;
  }

  static resolveAuth(auth: unknown): ResolvedAuth {
    if (!Text.isRecord(auth)) {
      return {};
    }

    if (auth.ok === false) {
      const reason =
        typeof auth.error === "string" && auth.error !== ""
          ? auth.error
          : "no credentials are configured for the current model";

      throw new Error(reason);
    }

    const resolved: ResolvedAuth = {};

    if (typeof auth.apiKey === "string" && auth.apiKey !== "") {
      resolved.apiKey = auth.apiKey;
    }

    if (Text.isRecord(auth.headers)) {
      const headers: Record<string, string> = {};

      for (const [key, value] of Object.entries(auth.headers)) {
        if (typeof value === "string") {
          headers[key] = value;
        }
      }

      if (Object.keys(headers).length > 0) {
        resolved.headers = headers;
      }
    }

    return resolved;
  }

  static resolveMaxTokens(modelMaxTokens: unknown, budget: number): number {
    if (typeof modelMaxTokens === "number" && Number.isFinite(modelMaxTokens) && modelMaxTokens > 0) {
      return Math.min(budget, modelMaxTokens);
    }

    return budget;
  }

  static resolveReasoning(reasoningEnabled: unknown, level: unknown): string | undefined {
    if (reasoningEnabled !== true) {
      return undefined;
    }

    if (typeof level === "string" && (PI_THINKING_LEVELS as readonly string[]).includes(level)) {
      return level;
    }

    return undefined;
  }
}
