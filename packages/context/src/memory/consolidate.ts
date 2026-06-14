import type { Store } from "./index.ts";
import { Text } from "./text.ts";

export interface BranchEntry {
  id: string;
  type: string;
  message?: unknown;
}

export interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

export interface Collected {
  transcript: string;
  lastId: string | null;
}

export interface Fact {
  topic: string;
  text: string;
}

export interface ConsolidationResult {
  saved: number;
  reason: string;
}

export interface Plan {
  skip: boolean;
  reason: string;
  facts: Fact[];
}

export const CURSOR_TYPE = "memory.cursor";

export class Consolidator {
  private readonly store: Store;

  private cursorValue: string | null = null;

  private turnCount = 0;

  private lastHash = "";

  constructor(store: Store) {
    this.store = store;
  }

  get cursor(): string | null {
    return this.cursorValue;
  }

  get turns(): number {
    return this.turnCount;
  }

  setCursor(value: string | null): void {
    this.cursorValue = value;
  }

  bumpTurn(): void {
    this.turnCount += 1;
  }

  resetTurns(): void {
    this.turnCount = 0;
  }

  restore(entries: readonly SessionEntry[]): void {
    this.cursorValue = null;
    this.turnCount = 0;

    for (const entry of entries) {

      if (entry.type !== "custom" || entry.customType !== CURSOR_TYPE) {
        continue;
      }

      const data = entry.data;

      if (data !== null && typeof data === "object" && typeof (data as { entryId?: unknown }).entryId === "string") {
        this.cursorValue = (data as { entryId: string }).entryId;
      }
    }
  }

  partText(content: unknown): string {

    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return "";
    }

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

  messageLine(message: unknown, budget: number): string | undefined {

    if (message === null || typeof message !== "object") {
      return undefined;
    }

    const role = (message as { role?: unknown }).role;
    const text = this.partText((message as { content?: unknown }).content).trim();

    if (text.length === 0) {
      return undefined;
    }

    if (role === "user") {
      return `User: ${this.store.clip(text, budget)}`;
    }

    if (role === "assistant") {
      return `Assistant: ${this.store.clip(text, budget)}`;
    }

    if (role === "toolResult" && (message as { isError?: unknown }).isError === true) {
      const tool =
        typeof (message as { toolName?: unknown }).toolName === "string"
          ? (message as { toolName: string }).toolName
          : "tool";

      return `Tool error (${tool}): ${this.store.clip(text, budget)}`;
    }

    return undefined;
  }

  tailClip(text: string, budget: number): string {

    if (budget <= 0 || text.length <= budget) {
      return text;
    }

    const slice = text.slice(text.length - budget);
    const cut = slice.indexOf("\n");

    return cut >= 0 && cut < slice.length - 1 ? slice.slice(cut + 1) : slice;
  }

  collect(entries: readonly BranchEntry[], cursor: string | null, budget: number): Collected {
    let start = 0;

    if (cursor !== null) {
      const at = entries.findIndex((entry) => entry.id === cursor);

      if (at >= 0) {
        start = at + 1;
      }
    }

    const lines: string[] = [];
    let lastId: string | null = null;

    for (let i = start; i < entries.length; i += 1) {
      const entry = entries[i];
      lastId = entry.id;

      if (entry.type !== "message") {
        continue;
      }

      const line = this.messageLine(entry.message, 600);

      if (line !== undefined) {
        lines.push(line);
      }
    }

    return { transcript: this.tailClip(lines.join("\n\n"), budget), lastId };
  }

  extractionPrompt(maxFacts: number): string {
    return [
      "You maintain long-term memory for a coding agent working in one project.",
      `Read the session excerpt and extract at most ${maxFacts} durable facts genuinely worth remembering in future sessions.`,
      "Durable facts are: stable project facts (build, test, and run commands, architecture decisions, environment quirks), explicit user preferences, and hard-won gotchas that cost real effort to discover.",
      "Never record source code or file contents that git already tracks, transient task state, in-progress work, or anything specific to this single session.",
      'Respond with a JSON array only, no prose, no code fences. Each element must be {"topic": "<short noun phrase>", "text": "<one to three plain sentences>"}.',
      "If nothing qualifies, respond with [].",
    ].join("\n");
  }

  parseFacts(raw: string, maxFacts: number): Fact[] {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");

    if (start < 0 || end <= start) {
      return [];
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    const facts: Fact[] = [];
    const seen = new Set<string>();

    for (const item of parsed) {

      if (facts.length >= maxFacts) {
        break;
      }

      if (item === null || typeof item !== "object") {
        continue;
      }

      const topic =
        typeof (item as { topic?: unknown }).topic === "string" ? (item as { topic: string }).topic.trim() : "";
      const text =
        typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text.trim() : "";

      if (topic.length === 0 || text.length === 0) {
        continue;
      }

      const slug = this.store.slugify(topic);

      if (seen.has(slug)) {
        continue;
      }

      seen.add(slug);
      facts.push({ topic, text });
    }

    return facts;
  }

  transcriptHash(transcript: string): string {
    return Text.sha256(transcript);
  }

  skipReason(transcript: string, lastId: string | null): string | undefined {

    if (lastId === null || transcript.length < 80) {
      return "nothing new to consolidate";
    }

    if (this.transcriptHash(transcript) === this.lastHash) {
      return "no new content since last consolidation";
    }

    return undefined;
  }

  markConsolidated(transcript: string, lastId: string | null): void {
    this.lastHash = this.transcriptHash(transcript);
    this.cursorValue = lastId;
  }

  runPlan(transcript: string, lastId: string | null, raw: string, maxFacts: number): Plan {
    const skip = this.skipReason(transcript, lastId);

    if (skip !== undefined) {
      return { skip: true, reason: skip, facts: [] };
    }

    const facts = this.parseFacts(raw, maxFacts);

    return { skip: false, reason: facts.length === 0 ? "no durable facts found" : "", facts };
  }
}
