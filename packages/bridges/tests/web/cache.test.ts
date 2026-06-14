import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheKey, DiskCache } from "../../src/web/cache.ts";
import type { SqlDatabase, SqlStatement } from "../../src/web/cache.ts";

interface Row {
  key: string;
  created_at: number;
  used_at: number;
  payload: string;
}

class FakeDatabase implements SqlDatabase {
  rows: Row[] = [];
  execLog: string[] = [];

  exec(sql: string): void {
    this.execLog.push(sql);
  }

  prepare(sql: string): SqlStatement {
    const rows = this.rows;
    const setRows = (next: Row[]) => {
      this.rows = next;
    };

    if (sql.startsWith("SELECT created_at, payload FROM entries WHERE key")) {
      return {
        run: () => undefined,
        get: (key: string | number | null) => {
          const found = rows.find((r) => r.key === key);
          return found ? { created_at: found.created_at, payload: found.payload } : undefined;
        },
      };
    }

    if (sql.startsWith("DELETE FROM entries WHERE key = ?")) {
      return {
        run: (key: string | number | null) => {
          setRows(rows.filter((r) => r.key !== key));
          return undefined;
        },
        get: () => undefined,
      };
    }

    if (sql.startsWith("UPDATE entries SET used_at")) {
      return {
        run: (usedAt: string | number | null, key: string | number | null) => {
          const found = rows.find((r) => r.key === key);
          if (found) {
            found.used_at = usedAt as number;
          }
          return undefined;
        },
        get: () => undefined,
      };
    }

    if (sql.startsWith("INSERT INTO entries")) {
      return {
        run: (key, createdAt, usedAt, payload) => {
          const existing = rows.find((r) => r.key === key);
          if (existing) {
            existing.created_at = createdAt as number;
            existing.used_at = usedAt as number;
            existing.payload = payload as string;
          } else {
            rows.push({
              key: key as string,
              created_at: createdAt as number,
              used_at: usedAt as number,
              payload: payload as string,
            });
          }
          return undefined;
        },
        get: () => undefined,
      };
    }

    if (sql.startsWith("DELETE FROM entries WHERE created_at < ?")) {
      return {
        run: (cutoff: string | number | null) => {
          setRows(rows.filter((r) => r.created_at >= (cutoff as number)));
          return undefined;
        },
        get: () => undefined,
      };
    }

    if (sql.startsWith("DELETE FROM entries WHERE key NOT IN")) {
      return {
        run: (limit: string | number | null) => {
          const keep = [...rows]
            .sort((a, b) => b.used_at - a.used_at)
            .slice(0, limit as number)
            .map((r) => r.key);
          setRows(rows.filter((r) => keep.includes(r.key)));
          return undefined;
        },
        get: () => undefined,
      };
    }

    throw new Error(`unexpected sql: ${sql}`);
  }
}

describe("CacheKey", () => {
  test("is deterministic sha1 hex", () => {
    const a = CacheKey.of(["search", "q", ["q"], 8]);
    const b = CacheKey.of(["search", "q", ["q"], 8]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  test("different inputs produce different keys", () => {
    expect(CacheKey.of(["fetch", "https://a"])).not.toBe(CacheKey.of(["fetch", "https://b"]));
  });

  test("undefined input hashes the literal string null", () => {
    expect(CacheKey.of(undefined)).toBe(createHash("sha1").update("null").digest("hex"));
  });
});

describe("DiskCache ttl=0", () => {
  test("get and set both no-op", () => {
    const db = new FakeDatabase();
    const cache = new DiskCache(0, 200, () => db, mkdtempSync(join(tmpdir(), "web-")));
    cache.set("k", { v: 1 });
    expect(cache.get("k")).toBeUndefined();
    expect(db.rows.length).toBe(0);
  });
});

describe("DiskCache round trip", () => {
  test("stores and retrieves payload", () => {
    const db = new FakeDatabase();
    const cache = new DiskCache(30, 200, () => db, mkdtempSync(join(tmpdir(), "web-")));
    cache.set("k", { text: "hello", tool: "web_search", count: 3 });
    expect(cache.get("k")).toEqual({ text: "hello", tool: "web_search", count: 3 });
  });

  test("expired entry is deleted and missed", () => {
    const db = new FakeDatabase();
    const root = mkdtempSync(join(tmpdir(), "web-"));
    const cache = new DiskCache(30, 200, () => db, root);
    cache.set("k", { v: 1 });
    db.rows[0].created_at = Date.now() - 31 * 60000;
    expect(cache.get("k")).toBeUndefined();
    expect(db.rows.length).toBe(0);
  });
});

describe("DiskCache LRU eviction", () => {
  test("evicts the least recently used beyond maxEntries", () => {
    const db = new FakeDatabase();
    const cache = new DiskCache(30, 2, () => db, mkdtempSync(join(tmpdir(), "web-")));
    cache.set("a", { v: 1 });
    cache.set("b", { v: 2 });
    db.rows.find((r) => r.key === "a")!.used_at = 10;
    db.rows.find((r) => r.key === "b")!.used_at = 20;
    cache.set("c", { v: 3 });
    const keys = db.rows.map((r) => r.key).sort();
    expect(db.rows.length).toBe(2);
    expect(keys).toEqual(["b", "c"]);
  });
});

describe("DiskCache graceful degradation", () => {
  test("opener throwing yields null handle and undefined gets", () => {
    const cache = new DiskCache(30, 200, () => {
      throw new Error("no sqlite");
    }, mkdtempSync(join(tmpdir(), "web-")));
    cache.set("k", { v: 1 });
    expect(cache.get("k")).toBeUndefined();
  });
});

describe("DiskCache legacy dir drop", () => {
  test("removes legacy webcache .json files on first open", () => {
    const root = mkdtempSync(join(tmpdir(), "web-"));
    const legacy = join(root, "webcache");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "old.json"), "{}");
    const db = new FakeDatabase();
    const cache = new DiskCache(30, 200, () => db, root);
    cache.get("trigger-open");
    expect(readdirSync(root)).not.toContain("webcache");
    rmSync(root, { recursive: true, force: true });
  });
});
