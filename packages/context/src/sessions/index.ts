import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Text } from "./text.ts";
import { Transcript } from "./transcript.ts";
import type {
  SessionLister,
  SessionSummary,
  SessionTranscript,
  TranscriptItem,
} from "./transcript.ts";

const TITLE_CAP = 72;

interface CachedTranscript {
  key: string;
  transcript: SessionTranscript;
}

export class Store {
  private readonly lister: SessionLister;
  private readonly cache = new Map<string, CachedTranscript>();

  constructor(lister: SessionLister) {
    this.lister = lister;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async listSessions(cwd: string, all: boolean): Promise<SessionSummary[]> {
    const raw: unknown = await this.lister(cwd, all);
    const out: SessionSummary[] = [];

    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!Text.isRecord(item)) {
          continue;
        }

        const path = typeof item.path === "string" ? item.path : "";

        if (path === "") {
          continue;
        }

        out.push({
          path,
          id:
            typeof item.id === "string" && item.id !== ""
              ? item.id
              : basename(path).replace(/\.jsonl$/i, ""),
          name: typeof item.name === "string" ? item.name : "",
          firstMessage: typeof item.firstMessage === "string" ? item.firstMessage : "",
          messageCount:
            typeof item.messageCount === "number" && Number.isFinite(item.messageCount)
              ? item.messageCount
              : 0,
          modified: Text.toTime(item.modified),
          created: Text.toTime(item.created),
          cwd: typeof item.cwd === "string" ? item.cwd : "",
        });
      }
    }

    out.sort((a, b) => b.modified - a.modified);

    return out;
  }

  loadTranscript(path: string): SessionTranscript {
    const key = Store.cacheKey(path);
    const cached = this.cache.get(path);

    if (cached !== undefined && cached.key === key) {
      return cached.transcript;
    }

    let raw: string;

    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(`could not read session file ${path}: ${Text.describeError(error)}`);
    }

    const entries: unknown[] = [];
    let id = "";
    let cwd = "";

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();

      if (trimmed === "") {
        continue;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (!Text.isRecord(parsed)) {
        continue;
      }

      if (parsed.type === "session") {
        if (typeof parsed.id === "string") {
          id = parsed.id;
        }

        if (typeof parsed.cwd === "string") {
          cwd = parsed.cwd;
        }

        continue;
      }

      entries.push(parsed);
    }

    if (id === "") {
      id = basename(path).replace(/\.jsonl$/i, "");
    }

    const transcript: SessionTranscript = { id, cwd, items: Transcript.entriesToItems(entries) };
    this.cache.set(path, { key, transcript });

    return transcript;
  }

  async resolveSession(spec: string, cwd: string): Promise<string> {
    const wanted = spec.trim();

    if (wanted === "") {
      throw new Error("a session id or file path is required");
    }

    if ((wanted.includes("/") || wanted.endsWith(".jsonl")) && existsSync(wanted)) {
      return wanted;
    }

    const local = await this.listSessions(cwd, false);
    let matched = Store.matchSummaries(local, wanted);

    if (matched.length === 0) {
      const everywhere = await this.listSessions(cwd, true);
      matched = Store.matchSummaries(everywhere, wanted);
    }

    const unique = [...new Set(matched.map((session) => session.path))];

    if (unique.length === 0) {
      throw new Error(`no session matches "${wanted}"; use history with op "list" to see available ids`);
    }

    if (unique.length > 1) {
      throw new Error(`"${wanted}" is ambiguous (${unique.length} sessions match); use a longer id prefix or the full file path`);
    }

    return unique[0];
  }

  private static cacheKey(path: string): string {
    try {
      const stat = statSync(path);

      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  static sessionTitle(session: SessionSummary): string {
    if (session.name.trim() !== "") {
      return Text.oneLine(session.name, TITLE_CAP);
    }

    if (session.firstMessage.trim() !== "") {
      return Text.oneLine(session.firstMessage, TITLE_CAP);
    }

    return "(untitled)";
  }

  static matchSummaries(sessions: SessionSummary[], wanted: string): SessionSummary[] {
    const exact = sessions.filter(
      (session) =>
        session.id === wanted || session.path === wanted || basename(session.path) === wanted,
    );

    if (exact.length > 0) {
      return exact;
    }

    return sessions.filter(
      (session) => session.id.startsWith(wanted) || basename(session.path).startsWith(wanted),
    );
  }

  static contentText(content: unknown): string {
    return Transcript.contentText(content);
  }

  static blockText(block: unknown): string {
    return Transcript.blockText(block);
  }

  static entriesToItems(entries: unknown[]): TranscriptItem[] {
    return Transcript.entriesToItems(entries);
  }
}
