import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { Text } from "./render.ts";

export interface ArtifactRecord {
  id: string;
  toolName: string;
  bytes: number;
  lines: number;
  ts: number;
}

export interface SqlStatement {
  run(...args: Array<string | number | null | Uint8Array>): unknown;
  get(...args: Array<string | number | null>): unknown;
  all(...args: Array<string | number | null>): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

export interface SessionSource {
  sessionManager: { getSessionFile(): unknown };
}

export type DatabaseOpener = (path: string) => SqlDatabase;

export function artifactsDbPath(): string {
  return join(homedir(), ".pi", "agent", "artifacts.db");
}

function legacyRoot(): string {
  return join(homedir(), ".pi", "agent", "artifacts");
}

function sanitizeTool(toolName: string): string {
  const trimmed = toolName.trim();

  return trimmed === "" ? "unknown" : trimmed;
}

function rowToRecord(row: Record<string, unknown>): ArtifactRecord | null {
  if (typeof row.id !== "string" || row.id === "") {
    return null;
  }

  return {
    id: row.id,
    toolName: typeof row.tool_name === "string" && row.tool_name !== "" ? row.tool_name : "unknown",
    bytes: typeof row.bytes === "number" && row.bytes >= 0 ? row.bytes : 0,
    lines: typeof row.lines === "number" && row.lines >= 0 ? row.lines : 0,
    ts: typeof row.ts === "number" && row.ts > 0 ? row.ts : 0,
  };
}

function defaultOpener(path: string): SqlDatabase {
  const require = createRequire(import.meta.url);
  const emitWarning = process.emitWarning;
  process.emitWarning = (() => undefined) as typeof process.emitWarning;

  try {
    const sqlite = require("node:sqlite") as { DatabaseSync: new (location: string) => SqlDatabase };
    mkdirSync(dirname(path), { recursive: true });

    return new sqlite.DatabaseSync(path);
  } finally {
    process.emitWarning = emitWarning;
  }
}

class Handle {
  private readonly statements = new Map<string, SqlStatement>();

  constructor(readonly db: SqlDatabase) {}

  prepared(sql: string): SqlStatement {
    const cached = this.statements.get(sql);

    if (cached) {
      return cached;
    }

    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);

    return statement;
  }
}

const SQL = {
  exists: "SELECT 1 AS hit FROM artifacts WHERE session_id = ? AND id = ?",
  insert: "INSERT INTO artifacts (session_id, id, tool_name, bytes, lines, ts, content) VALUES (?, ?, ?, ?, ?, ?, ?)",
  meta: "SELECT id, tool_name, bytes, lines, ts FROM artifacts WHERE session_id = ? AND id = ?",
  content: "SELECT content FROM artifacts WHERE session_id = ? AND id = ?",
  list: "SELECT id, tool_name, bytes, lines, ts FROM artifacts WHERE session_id = ? ORDER BY ts DESC",
  remove: "DELETE FROM artifacts WHERE session_id = ? AND id = ?",
  prune: "DELETE FROM artifacts WHERE ts < ?",
};

export class ArtifactStore {
  private sessionId = "";
  private readonly fallback = `unsaved-${randomBytes(4).toString("hex")}`;
  private handle: Handle | null | undefined;

  constructor(private readonly opener: DatabaseOpener = defaultOpener) {}

  attach(source: SessionSource): void {
    this.sessionId = this.resolveSessionId(source);
  }

  resolveSessionId(source: SessionSource): string {
    try {
      const file: unknown = source.sessionManager.getSessionFile();

      if (typeof file === "string" && file.trim() !== "") {
        const base = basename(file.trim());
        const dot = base.lastIndexOf(".");
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const safe = stem.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");

        if (safe !== "") {
          return safe;
        }
      }
    } catch {
      return this.fallback;
    }

    return this.fallback;
  }

  private open(): Handle | null {
    if (this.handle !== undefined) {
      return this.handle;
    }

    try {
      const db = this.opener(artifactsDbPath());
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec(
        "CREATE TABLE IF NOT EXISTS artifacts (session_id TEXT NOT NULL, id TEXT NOT NULL, tool_name TEXT NOT NULL, bytes INTEGER NOT NULL, lines INTEGER NOT NULL, ts INTEGER NOT NULL, content BLOB NOT NULL, PRIMARY KEY (session_id, id)) STRICT",
      );
      db.exec("CREATE INDEX IF NOT EXISTS artifacts_ts ON artifacts (ts)");
      this.handle = new Handle(db);
      this.migrateLegacyDirs(this.handle);
    } catch {
      this.handle = null;
    }

    return this.handle;
  }

  spillText(toolName: string, text: string): ArtifactRecord | null {
    const handle = this.open();

    if (!handle) {
      return null;
    }

    try {
      const exists = handle.prepared(SQL.exists);
      let id = randomBytes(4).toString("hex");

      while (exists.get(this.sessionId, id) !== undefined) {
        id = randomBytes(4).toString("hex");
      }

      const record: ArtifactRecord = {
        id,
        toolName: sanitizeTool(toolName),
        bytes: Buffer.byteLength(text, "utf8"),
        lines: Text.splitLines(text).length,
        ts: Date.now(),
      };

      handle
        .prepared(SQL.insert)
        .run(this.sessionId, record.id, record.toolName, record.bytes, record.lines, record.ts, zstdCompressSync(Buffer.from(text, "utf8")));

      return record;
    } catch {
      return null;
    }
  }

  spill(source: SessionSource, toolName: string, text: string): ArtifactRecord | null {
    this.attach(source);

    return this.spillText(toolName, text);
  }

  get(source: SessionSource, id: string): ArtifactRecord | undefined {
    this.attach(source);
    const handle = this.open();

    if (!handle) {
      return undefined;
    }

    try {
      const row = handle.prepared(SQL.meta).get(this.sessionId, id) as Record<string, unknown> | undefined;

      return row ? (rowToRecord(row) ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  }

  read(source: SessionSource, id: string): string | null {
    this.attach(source);
    const handle = this.open();

    if (!handle) {
      return null;
    }

    try {
      const row = handle.prepared(SQL.content).get(this.sessionId, id) as { content?: unknown } | undefined;

      if (!row || !(row.content instanceof Uint8Array)) {
        return null;
      }

      return zstdDecompressSync(row.content).toString("utf8");
    } catch {
      return null;
    }
  }

  list(source: SessionSource): ArtifactRecord[] {
    this.attach(source);
    const handle = this.open();

    if (!handle) {
      return [];
    }

    try {
      const rows = handle.prepared(SQL.list).all(this.sessionId) as Array<Record<string, unknown>>;

      return rows.map(rowToRecord).filter((record): record is ArtifactRecord => record !== null);
    } catch {
      return [];
    }
  }

  remove(id: string): void {
    const handle = this.open();

    if (!handle || this.sessionId === "") {
      return;
    }

    try {
      handle.prepared(SQL.remove).run(this.sessionId, id);
    } catch {
      void 0;
    }
  }

  prune(maxAgeDays: number): void {
    const handle = this.open();

    if (!handle) {
      return;
    }

    const cutoff = Date.now() - maxAgeDays * 86400000;

    try {
      handle.prepared(SQL.prune).run(cutoff);
      handle.db.exec("PRAGMA incremental_vacuum");
    } catch {
      void 0;
    }
  }

  private migrateLegacyDirs(handle: Handle): void {
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
        if (!statSync(dir).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      this.migrateLegacySession(handle, dir, name);
    }

    try {
      rmdirSync(root);
    } catch {
      void 0;
    }
  }

  private migrateLegacySession(handle: Handle, dir: string, sessionId: string): void {
    const indexPath = join(dir, "index.json");
    const known = readLegacyIndex(indexPath);
    let entries: string[] = [];

    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    const insert = handle.prepared(
      "INSERT OR IGNORE INTO artifacts (session_id, id, tool_name, bytes, lines, ts, content) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );

    for (const entry of entries) {
      if (!entry.endsWith(".txt")) {
        continue;
      }

      const id = entry.slice(0, -4);

      if (!/^[0-9a-f]{8}$/.test(id)) {
        continue;
      }

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
          legacy && legacy.lines > 0 ? legacy.lines : Text.splitLines(text).length,
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
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          continue;
        }

        const record = value as Record<string, unknown>;

        if (typeof record.id !== "string" || record.id.trim() === "") {
          continue;
        }

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
