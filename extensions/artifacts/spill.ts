import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ArtifactRecord {
  id: string;
  toolName: string;
  bytes: number;
  lines: number;
  ts: number;
}

export interface ArtifactsConfig {
  spillBytes: number;
  headLines: number;
  tailLines: number;
  skipTools: string[];
  maxAgeDays: number;
  retrieveLines: number;
}

interface SqlStatement {
  run(...args: (string | number | null | Uint8Array)[]): unknown;
  get(...args: (string | number | null)[]): unknown;
  all(...args: (string | number | null)[]): unknown[];
}

interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

export function artifactsDbPath(): string {
  return join(homedir(), ".pi", "agent", "artifacts.db");
}

function legacyRoot(): string {
  return join(homedir(), ".pi", "agent", "artifacts");
}

let handle: SqlDatabase | null | undefined;

function db(): SqlDatabase | null {
  if (handle !== undefined) return handle;
  const require = createRequire(import.meta.url);
  const emitWarning = process.emitWarning;
  process.emitWarning = () => undefined;
  try {
    const sqlite = require("node:sqlite") as { DatabaseSync: new (location: string) => SqlDatabase };
    const path = artifactsDbPath();
    mkdirSync(dirname(path), { recursive: true });
    const opened = new sqlite.DatabaseSync(path);
    opened.exec("PRAGMA auto_vacuum = INCREMENTAL");
    opened.exec("PRAGMA journal_mode = WAL");
    opened.exec("PRAGMA busy_timeout = 5000");
    opened.exec("PRAGMA synchronous = NORMAL");
    opened.exec(
      "CREATE TABLE IF NOT EXISTS artifacts (session_id TEXT NOT NULL, id TEXT NOT NULL, tool_name TEXT NOT NULL, bytes INTEGER NOT NULL, lines INTEGER NOT NULL, ts INTEGER NOT NULL, content BLOB NOT NULL, PRIMARY KEY (session_id, id)) STRICT",
    );
    opened.exec("CREATE INDEX IF NOT EXISTS artifacts_ts ON artifacts (ts)");
    handle = opened;
    migrateLegacyDirs(opened);
  } catch {
    handle = null;
  } finally {
    process.emitWarning = emitWarning;
  }
  return handle;
}

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? String(Math.round(value)) : value.toFixed(1)} ${unit}`;
}

export function utf8Head(text: string, maxBytes: number): { text: string; clipped: boolean } {
  const buf = Buffer.from(text, "utf8");
  const cap = Math.max(0, Math.floor(maxBytes));
  if (buf.length <= cap) return { text, clipped: false };
  let end = cap;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), clipped: true };
}

export function utf8Tail(text: string, maxBytes: number): { text: string; clipped: boolean } {
  const buf = Buffer.from(text, "utf8");
  const cap = Math.max(0, Math.floor(maxBytes));
  if (buf.length <= cap) return { text, clipped: false };
  let start = buf.length - cap;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return { text: buf.subarray(start).toString("utf8"), clipped: true };
}

function sanitizeTool(toolName: string): string {
  const trimmed = toolName.trim();
  return trimmed === "" ? "unknown" : trimmed;
}

function rowToRecord(row: Record<string, unknown>): ArtifactRecord | null {
  if (typeof row.id !== "string" || row.id === "") return null;
  return {
    id: row.id,
    toolName: typeof row.tool_name === "string" && row.tool_name !== "" ? row.tool_name : "unknown",
    bytes: typeof row.bytes === "number" && row.bytes >= 0 ? row.bytes : 0,
    lines: typeof row.lines === "number" && row.lines >= 0 ? row.lines : 0,
    ts: typeof row.ts === "number" && row.ts > 0 ? row.ts : 0,
  };
}

export function buildReplacement(text: string, record: ArtifactRecord, config: ArtifactsConfig): string {
  const lines = splitLines(text);
  const total = lines.length;
  const windowCap = Math.max(1024, Math.floor(config.spillBytes / 4));
  const overlap = total <= config.headLines + config.tailLines;
  const headCount = overlap ? total : config.headLines;
  const tailCount = overlap ? 0 : config.tailLines;
  const omitted = total - headCount - tailCount;
  const parts: string[] = [];
  if (headCount > 0) {
    const head = utf8Head(lines.slice(0, headCount).join("\n"), windowCap);
    parts.push(head.clipped ? `${head.text}\n[head window clipped at ${formatBytes(windowCap)}]` : head.text);
  }
  const shape =
    omitted > 0
      ? `showing first ${headCount} and last ${tailCount} lines; lines ${headCount + 1}-${total - tailCount} (${omitted} line${omitted === 1 ? "" : "s"}) omitted`
      : "all lines shown above but long lines were clipped; the full text is stored";
  const banner = [
    `[output spilled to artifact ${record.id}: ${formatBytes(record.bytes)}, ${total} line${total === 1 ? "" : "s"} total]`,
    `[${shape}]`,
    `[retrieve with the artifact tool: {"id":"${record.id}"} reads from the start; add offset (1-based line) and limit to page through it; {"id":"list"} lists all session artifacts]`,
  ].join("\n");
  parts.push(banner);
  if (tailCount > 0) {
    const tail = utf8Tail(lines.slice(total - tailCount).join("\n"), windowCap);
    parts.push(tail.clipped ? `[tail window clipped at ${formatBytes(windowCap)}]\n${tail.text}` : tail.text);
  }
  return parts.join("\n\n");
}

export class ArtifactStore {
  private sessionId = "";
  private readonly fallback = `unsaved-${randomBytes(4).toString("hex")}`;

  attach(ctx: ExtensionContext): void {
    this.sessionId = this.resolveSessionId(ctx);
  }

  private resolveSessionId(ctx: ExtensionContext): string {
    try {
      const file: unknown = ctx.sessionManager.getSessionFile();
      if (typeof file === "string" && file.trim() !== "") {
        const base = basename(file.trim());
        const dot = base.lastIndexOf(".");
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const safe = stem.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
        if (safe !== "") return safe;
      }
    } catch {
      return this.fallback;
    }
    return this.fallback;
  }

  spill(ctx: ExtensionContext, toolName: string, text: string): ArtifactRecord | null {
    this.attach(ctx);
    const store = db();
    if (!store) return null;
    try {
      const exists = store.prepare("SELECT 1 AS hit FROM artifacts WHERE session_id = ? AND id = ?");
      let id = randomBytes(4).toString("hex");
      while (exists.get(this.sessionId, id) !== undefined) {
        id = randomBytes(4).toString("hex");
      }
      const record: ArtifactRecord = {
        id,
        toolName: sanitizeTool(toolName),
        bytes: Buffer.byteLength(text, "utf8"),
        lines: splitLines(text).length,
        ts: Date.now(),
      };
      store
        .prepare("INSERT INTO artifacts (session_id, id, tool_name, bytes, lines, ts, content) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(this.sessionId, record.id, record.toolName, record.bytes, record.lines, record.ts, zstdCompressSync(Buffer.from(text, "utf8")));
      return record;
    } catch {
      return null;
    }
  }

  get(ctx: ExtensionContext, id: string): ArtifactRecord | undefined {
    this.attach(ctx);
    const store = db();
    if (!store) return undefined;
    try {
      const row = store
        .prepare("SELECT id, tool_name, bytes, lines, ts FROM artifacts WHERE session_id = ? AND id = ?")
        .get(this.sessionId, id) as Record<string, unknown> | undefined;
      return row ? (rowToRecord(row) ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  }

  read(ctx: ExtensionContext, id: string): string | null {
    this.attach(ctx);
    const store = db();
    if (!store) return null;
    try {
      const row = store
        .prepare("SELECT content FROM artifacts WHERE session_id = ? AND id = ?")
        .get(this.sessionId, id) as { content?: unknown } | undefined;
      if (!row || !(row.content instanceof Uint8Array)) return null;
      return zstdDecompressSync(row.content).toString("utf8");
    } catch {
      return null;
    }
  }

  list(ctx: ExtensionContext): ArtifactRecord[] {
    this.attach(ctx);
    const store = db();
    if (!store) return [];
    try {
      const rows = store
        .prepare("SELECT id, tool_name, bytes, lines, ts FROM artifacts WHERE session_id = ? ORDER BY ts DESC")
        .all(this.sessionId) as Record<string, unknown>[];
      return rows.map(rowToRecord).filter((record): record is ArtifactRecord => record !== null);
    } catch {
      return [];
    }
  }

  remove(id: string): void {
    const store = db();
    if (!store || this.sessionId === "") return;
    try {
      store.prepare("DELETE FROM artifacts WHERE session_id = ? AND id = ?").run(this.sessionId, id);
    } catch {
      void 0;
    }
  }
}

interface LegacyRecord {
  toolName: string;
  lines: number;
  ts: number;
}

function readLegacyIndex(path: string): Map<string, LegacyRecord> {
  const records = new Map<string, LegacyRecord>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        if (typeof record.id !== "string" || record.id.trim() === "") continue;
        records.set(record.id.trim(), {
          toolName: typeof record.toolName === "string" && record.toolName.trim() !== "" ? record.toolName : "unknown",
          lines: typeof record.lines === "number" && Number.isInteger(record.lines) && record.lines >= 0 ? record.lines : 0,
          ts: typeof record.ts === "number" && Number.isFinite(record.ts) && record.ts > 0 ? record.ts : 0,
        });
      }
    }
  } catch {
    records.clear();
  }
  return records;
}

function migrateLegacySession(store: SqlDatabase, dir: string, sessionId: string): void {
  const indexPath = join(dir, "index.json");
  const known = readLegacyIndex(indexPath);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const insert = store.prepare(
    "INSERT OR IGNORE INTO artifacts (session_id, id, tool_name, bytes, lines, ts, content) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const entry of entries) {
    if (!entry.endsWith(".txt")) continue;
    const id = entry.slice(0, -4);
    if (!/^[0-9a-f]{8}$/.test(id)) continue;
    const full = join(dir, entry);
    let text: string;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const legacy = known.get(id);
    try {
      insert.run(
        sessionId,
        id,
        legacy?.toolName ?? "unknown",
        Buffer.byteLength(text, "utf8"),
        legacy && legacy.lines > 0 ? legacy.lines : splitLines(text).length,
        legacy && legacy.ts > 0 ? legacy.ts : Math.round(mtimeMs),
        zstdCompressSync(Buffer.from(text, "utf8")),
      );
      unlinkSync(full);
    } catch {
      continue;
    }
  }
  try {
    unlinkSync(indexPath);
  } catch {
    void 0;
  }
  try {
    rmdirSync(dir);
  } catch {
    void 0;
  }
}

function migrateLegacyDirs(store: SqlDatabase): void {
  const root = legacyRoot();
  let sessionDirs: string[] = [];
  try {
    sessionDirs = readdirSync(root);
  } catch {
    return;
  }
  for (const name of sessionDirs) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    migrateLegacySession(store, dir, name);
  }
  try {
    rmdirSync(root);
  } catch {
    void 0;
  }
}

export function pruneArtifacts(maxAgeDays: number): void {
  const store = db();
  if (!store) return;
  const cutoff = Date.now() - maxAgeDays * 86400000;
  try {
    store.prepare("DELETE FROM artifacts WHERE ts < ?").run(cutoff);
    store.exec("PRAGMA incremental_vacuum");
  } catch {
    void 0;
  }
}
