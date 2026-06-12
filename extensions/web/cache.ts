import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function cacheKey(parts: unknown): string {
  return createHash("sha1").update(JSON.stringify(parts) ?? "null").digest("hex");
}

interface SqlStatement {
  run(...args: (string | number | null)[]): unknown;
  get(...args: (string | number | null)[]): unknown;
}

interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

function openDatabase(path: string): SqlDatabase {
  const require = createRequire(import.meta.url);
  const emitWarning = process.emitWarning;
  process.emitWarning = () => undefined;
  try {
    const sqlite = require("node:sqlite") as { DatabaseSync: new (location: string) => SqlDatabase };
    mkdirSync(dirname(path), { recursive: true });
    const db = new sqlite.DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA synchronous = NORMAL");
    return db;
  } finally {
    process.emitWarning = emitWarning;
  }
}

function dropLegacyDir(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      void 0;
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    void 0;
  }
}

export class DiskCache {
  private readonly path: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private handle: SqlDatabase | null | undefined;

  constructor(ttlMinutes: number, maxEntries: number) {
    this.path = join(homedir(), ".pi", "agent", "webcache.db");
    this.ttlMs = Math.max(0, ttlMinutes) * 60000;
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  private db(): SqlDatabase | null {
    if (this.handle !== undefined) return this.handle;
    try {
      const db = openDatabase(this.path);
      db.exec(
        "CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL, used_at INTEGER NOT NULL, payload TEXT NOT NULL) STRICT",
      );
      db.exec("CREATE INDEX IF NOT EXISTS entries_used_at ON entries (used_at)");
      dropLegacyDir(join(homedir(), ".pi", "agent", "webcache"));
      this.handle = db;
    } catch {
      this.handle = null;
    }
    return this.handle;
  }

  get(key: string): unknown {
    if (this.ttlMs <= 0) return undefined;
    const db = this.db();
    if (!db) return undefined;
    try {
      const row = db.prepare("SELECT created_at, payload FROM entries WHERE key = ?").get(key) as
        | { created_at: number; payload: string }
        | undefined;
      if (!row) return undefined;
      if (Date.now() - row.created_at > this.ttlMs) {
        db.prepare("DELETE FROM entries WHERE key = ?").run(key);
        return undefined;
      }
      const payload: unknown = JSON.parse(row.payload);
      db.prepare("UPDATE entries SET used_at = ? WHERE key = ?").run(Date.now(), key);
      return payload;
    } catch {
      return undefined;
    }
  }

  set(key: string, payload: unknown): void {
    if (this.ttlMs <= 0) return;
    const db = this.db();
    if (!db) return;
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return;
    }
    if (typeof serialized !== "string") return;
    const now = Date.now();
    try {
      db.prepare(
        "INSERT INTO entries (key, created_at, used_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET created_at = excluded.created_at, used_at = excluded.used_at, payload = excluded.payload",
      ).run(key, now, now, serialized);
      db.prepare("DELETE FROM entries WHERE created_at < ?").run(now - this.ttlMs);
      db.prepare("DELETE FROM entries WHERE key NOT IN (SELECT key FROM entries ORDER BY used_at DESC LIMIT ?)").run(
        this.maxEntries,
      );
    } catch {
      return;
    }
  }
}
