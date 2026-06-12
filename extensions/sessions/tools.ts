import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface SessionsConfig {
  listLimit: number;
  readLimit: number;
  searchLimit: number;
  excerptChars: number;
  contextEntries: number;
  allowSwitch: boolean;
  btwBudget: number;
  btwMaxTokens: number;
}

export interface SessionSummary {
  path: string;
  id: string;
  name: string;
  firstMessage: string;
  messageCount: number;
  modified: number;
  created: number;
  cwd: string;
}

export interface TranscriptItem {
  index: number;
  entryId: string;
  label: string;
  text: string;
}

export interface SessionTranscript {
  id: string;
  cwd: string;
  items: TranscriptItem[];
}

export interface SearchHit {
  path: string;
  sessionId: string;
  sessionTitle: string;
  modified: number;
  itemIndex: number;
  label: string;
  excerpt: string;
}

interface ToolText {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolText[];
  details: Record<string, unknown>;
}

interface HistoryArgs {
  op: "list" | "read" | "search" | "info";
  all?: boolean;
  session?: string;
  offset?: number;
  limit?: number;
  query?: string;
}

const ITEM_CAP = 1600;
const OUTPUT_CAP = 45000;
const CALL_ARG_CAP = 220;
const RESULT_LINE_CAP = 300;
const TITLE_CAP = 72;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)} [+${text.length - limit} chars]`;
}

export function oneLine(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit)}…`;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function toTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function formatStamp(ms: number): string {
  if (ms <= 0) return "unknown time";
  const date = new Date(ms);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function sessionTitle(session: SessionSummary): string {
  if (session.name.trim() !== "") return oneLine(session.name, TITLE_CAP);
  if (session.firstMessage.trim() !== "") return oneLine(session.firstMessage, TITLE_CAP);
  return "(untitled)";
}

export async function listSessions(cwd: string, all: boolean): Promise<SessionSummary[]> {
  const raw: unknown = all ? await SessionManager.listAll() : await SessionManager.list(cwd);
  const out: SessionSummary[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const path = typeof item.path === "string" ? item.path : "";
      if (path === "") continue;
      out.push({
        path,
        id: typeof item.id === "string" && item.id !== "" ? item.id : basename(path).replace(/\.jsonl$/i, ""),
        name: typeof item.name === "string" ? item.name : "",
        firstMessage: typeof item.firstMessage === "string" ? item.firstMessage : "",
        messageCount: typeof item.messageCount === "number" && Number.isFinite(item.messageCount) ? item.messageCount : 0,
        modified: toTime(item.modified),
        created: toTime(item.created),
        cwd: typeof item.cwd === "string" ? item.cwd : "",
      });
    }
  }
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!isRecord(block)) return "";
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "thinking") return "";
  if (block.type === "toolCall") {
    const name = typeof block.name === "string" ? block.name : "tool";
    let argsText = "";
    try {
      argsText = JSON.stringify(block.arguments ?? block.input ?? {});
    } catch {
      argsText = "(unserializable arguments)";
    }
    return `[tool ${name}(${oneLine(argsText, CALL_ARG_CAP)})]`;
  }
  if (block.type === "image") return "[image]";
  return "";
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(blockText)
    .filter((part) => part !== "")
    .join("\n");
}

export function entriesToItems(entries: unknown[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const push = (entryId: string, label: string, text: string): void => {
    const cleaned = text.replace(/\r/g, "").trim();
    if (cleaned === "") return;
    items.push({ index: items.length, entryId, label, text: clip(cleaned, ITEM_CAP) });
  };
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const entryId = typeof entry.id === "string" ? entry.id : "";
    if (entry.type === "message" && isRecord(entry.message)) {
      const message = entry.message;
      const role = typeof message.role === "string" ? message.role : "";
      if (role === "user") {
        push(entryId, "user", contentText(message.content));
      } else if (role === "assistant") {
        push(entryId, "assistant", contentText(message.content));
      } else if (role === "toolResult") {
        const name = typeof message.toolName === "string" ? message.toolName : "tool";
        push(entryId, "tool", `[${name} result] ${oneLine(contentText(message.content), RESULT_LINE_CAP)}`);
      } else if (role !== "") {
        push(entryId, role, contentText(message.content));
      }
    } else if (entry.type === "custom_message") {
      const customType = typeof entry.customType === "string" ? entry.customType : "extension";
      push(entryId, `note:${customType}`, contentText(entry.content));
    } else if (entry.type === "compaction" && typeof entry.summary === "string") {
      push(entryId, "compaction", entry.summary);
    } else if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      push(entryId, "branch", entry.summary);
    } else if (entry.type === "model_change") {
      const provider = typeof entry.provider === "string" ? entry.provider : "";
      const modelId = typeof entry.modelId === "string" ? entry.modelId : "";
      push(entryId, "model", `switched to ${provider}/${modelId}`);
    }
  }
  return items;
}

export function loadTranscript(path: string): SessionTranscript {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`could not read session file ${path}: ${describeError(error)}`);
  }
  const entries: unknown[] = [];
  let id = "";
  let cwd = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed.type === "session") {
      if (typeof parsed.id === "string") id = parsed.id;
      if (typeof parsed.cwd === "string") cwd = parsed.cwd;
      continue;
    }
    entries.push(parsed);
  }
  if (id === "") id = basename(path).replace(/\.jsonl$/i, "");
  return { id, cwd, items: entriesToItems(entries) };
}

function makeExcerpt(text: string, at: number, matchLength: number, excerptChars: number): string {
  const lead = Math.max(0, Math.floor((excerptChars - matchLength) / 3));
  const start = Math.max(0, at - lead);
  const end = Math.min(text.length, start + Math.max(matchLength, excerptChars));
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${oneLine(text.slice(start, end), excerptChars + matchLength)}${suffix}`;
}

export function searchSessions(
  query: string,
  sessions: SessionSummary[],
  cap: number,
  excerptChars: number,
  signal?: AbortSignal,
): SearchHit[] {
  const needle = query.toLowerCase();
  if (needle === "") return [];
  const hits: SearchHit[] = [];
  for (const session of sessions) {
    if (signal?.aborted) break;
    let transcript: SessionTranscript;
    try {
      transcript = loadTranscript(session.path);
    } catch {
      continue;
    }
    for (const item of transcript.items) {
      const at = item.text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      hits.push({
        path: session.path,
        sessionId: session.id,
        sessionTitle: sessionTitle(session),
        modified: session.modified,
        itemIndex: item.index,
        label: item.label,
        excerpt: makeExcerpt(item.text, at, needle.length, excerptChars),
      });
      if (hits.length >= cap) return hits;
    }
  }
  return hits;
}

function matchSummaries(sessions: SessionSummary[], wanted: string): SessionSummary[] {
  const exact = sessions.filter(
    (session) => session.id === wanted || session.path === wanted || basename(session.path) === wanted,
  );
  if (exact.length > 0) return exact;
  return sessions.filter(
    (session) => session.id.startsWith(wanted) || basename(session.path).startsWith(wanted),
  );
}

export async function resolveSession(spec: string, cwd: string): Promise<string> {
  const wanted = spec.trim();
  if (wanted === "") throw new Error("a session id or file path is required");
  if ((wanted.includes("/") || wanted.endsWith(".jsonl")) && existsSync(wanted)) return wanted;
  const local = await listSessions(cwd, false);
  let matched = matchSummaries(local, wanted);
  if (matched.length === 0) {
    const everywhere = await listSessions(cwd, true);
    matched = matchSummaries(everywhere, wanted);
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

function sessionFileOf(ctx: ExtensionContext): string {
  try {
    const file: unknown = ctx.sessionManager.getSessionFile();
    return typeof file === "string" ? file : "";
  } catch {
    return "";
  }
}

function listText(sessions: SessionSummary[], all: boolean, cwd: string, limit: number, current: string): string {
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
    lines.push(`${marker} ${session.id.slice(0, 8)}  ${formatStamp(session.modified)}  ${String(session.messageCount).padStart(4)} msgs  ${sessionTitle(session)}`);
    lines.push(`    ${session.path}`);
  }
  if (sessions.length > shown.length) {
    lines.push("", `(${sessions.length - shown.length} older sessions not shown)`);
  }
  return lines.join("\n");
}

function readText(path: string, transcript: SessionTranscript, offset: number, limit: number): string {
  const total = transcript.items.length;
  const slice = transcript.items.slice(offset, offset + limit);
  const header: string[] = [
    `Transcript of ${path} (session ${transcript.id.slice(0, 8)})`,
    `Items ${offset}-${offset + slice.length - 1} of ${total}.`,
  ];
  if (offset > 0) header.push(`Earlier items exist; re-run with offset:${Math.max(0, offset - limit)}.`);
  if (offset + slice.length < total) header.push(`Later items exist; re-run with offset:${offset + slice.length}.`);
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

function searchText(query: string, hits: SearchHit[], cap: number, all: boolean): string {
  if (hits.length === 0) {
    return `No matches for "${query}"${all ? "" : "; pass all:true to search every project"}.`;
  }
  const sessionCount = new Set(hits.map((hit) => hit.path)).size;
  const lines: string[] = [
    `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}" in ${sessionCount} session${sessionCount === 1 ? "" : "s"}${hits.length >= cap ? ` (capped at ${cap})` : ""}:`,
  ];
  let lastPath = "";
  for (const hit of hits) {
    if (hit.path !== lastPath) {
      lastPath = hit.path;
      lines.push("", `${hit.sessionId.slice(0, 8)}  ${formatStamp(hit.modified)}  ${hit.sessionTitle}`, `  ${hit.path}`);
    }
    lines.push(`  [${hit.itemIndex} ${hit.label}] ${hit.excerpt}`);
  }
  lines.push("", 'Read surrounding context with history op:"read", session:"<id>", offset:<item index>.');
  return lines.join("\n");
}

export function registerHistoryTool(pi: ExtensionAPI, config: SessionsConfig): void {
  const parameters = Type.Object({
    op: StringEnum(["list", "read", "search", "info"], {
      description: "list recent sessions, read one session transcript, search transcripts for literal text, or show info about the current session",
    }),
    all: Type.Optional(Type.Boolean({ description: "for list and search: include sessions from every project, not just the current one" })),
    session: Type.Optional(Type.String({ description: "for read: session id, unique id prefix, or session file path" })),
    offset: Type.Optional(Type.Number({ description: "for read: transcript item index to start from; defaults to the tail of the transcript" })),
    limit: Type.Optional(Type.Number({ description: `for read: maximum transcript items to return (default ${config.readLimit})` })),
    query: Type.Optional(Type.String({ description: "for search: literal text to find, matched case-insensitively" })),
  });

  pi.registerTool({
    name: "history",
    label: "History",
    description: `Inspect saved pi sessions. Ops: list (recent sessions for this project with id, date, name, and message count; all:true for every project), read (a readable transcript slice of one session: roles plus text, tool calls as one-line summaries; session required, offset/limit optional and default to the tail), search (case-insensitive literal scan across saved transcripts; query required, all:true widens scope, capped at ${config.searchLimit} matches), info (current session file path, entry count, and branch depth).`,
    parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolResult> {
      const args = params as HistoryArgs;
      if (signal?.aborted) throw new Error("history: aborted");
      switch (args.op) {
        case "list": {
          const all = args.all === true;
          const sessions = await listSessions(ctx.cwd, all);
          const shown = sessions.slice(0, config.listLimit);
          return {
            content: [{ type: "text", text: listText(sessions, all, ctx.cwd, config.listLimit, sessionFileOf(ctx)) }],
            details: { total: sessions.length, sessions: shown },
          };
        }
        case "read": {
          if (typeof args.session !== "string" || args.session.trim() === "") {
            throw new Error('op "read" requires a session id or file path');
          }
          const path = await resolveSession(args.session, ctx.cwd);
          const transcript = loadTranscript(path);
          const total = transcript.items.length;
          if (total === 0) {
            return {
              content: [{ type: "text", text: `Session ${path} has no readable transcript entries.` }],
              details: { path, total: 0 },
            };
          }
          const limit = clampInt(args.limit, 1, 500, config.readLimit);
          const offset =
            args.offset !== undefined
              ? clampInt(args.offset, 0, Math.max(0, total - 1), 0)
              : Math.max(0, total - limit);
          return {
            content: [{ type: "text", text: readText(path, transcript, offset, limit) }],
            details: { path, sessionId: transcript.id, total, offset, limit },
          };
        }
        case "search": {
          if (typeof args.query !== "string" || args.query.trim() === "") {
            throw new Error('op "search" requires a non-empty query');
          }
          const all = args.all === true;
          const query = args.query.trim();
          const sessions = await listSessions(ctx.cwd, all);
          const hits = searchSessions(query, sessions, config.searchLimit, config.excerptChars, signal);
          return {
            content: [{ type: "text", text: searchText(query, hits, config.searchLimit, all) }],
            details: { query, all, hits },
          };
        }
        case "info": {
          const file = sessionFileOf(ctx);
          let entryCount = 0;
          let branchDepth = 0;
          let leaf = "";
          try {
            const entries: unknown = ctx.sessionManager.getEntries();
            if (Array.isArray(entries)) entryCount = entries.length;
          } catch {
            entryCount = 0;
          }
          try {
            const branch: unknown = ctx.sessionManager.getBranch();
            if (Array.isArray(branch)) branchDepth = branch.length;
          } catch {
            branchDepth = 0;
          }
          try {
            const leafId: unknown = ctx.sessionManager.getLeafId();
            if (typeof leafId === "string") leaf = leafId;
          } catch {
            leaf = "";
          }
          let name = "";
          try {
            const sessionName: unknown = pi.getSessionName();
            if (typeof sessionName === "string") name = sessionName;
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
        default:
          throw new Error(`unknown op "${String(args.op)}"`);
      }
    },
  });
}
