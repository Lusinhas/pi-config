import { describe, expect, test } from "bun:test";
import { zstdCompressSync } from "node:zlib";
import {
  ArtifactStore,
  type SessionSource,
  type SqlDatabase,
  type SqlStatement,
} from "../../src/artifacts/index.ts";
import { Config } from "../../src/artifacts/render.ts";
import { Spiller } from "../../src/artifacts/retrieve.ts";

interface Row {
  session_id: string;
  id: string;
  tool_name: string;
  bytes: number;
  lines: number;
  ts: number;
  content: Uint8Array;
}

class FakeDb implements SqlDatabase {
  readonly execed: string[] = [];
  rows: Row[] = [];

  exec(sql: string): void {
    this.execed.push(sql);
  }

  prepare(sql: string): SqlStatement {
    const trimmed = sql.replace(/\s+/g, " ").trim();
    const db = this;

    if (trimmed.startsWith("SELECT 1 AS hit")) {
      return statement({
        get(sessionId, id) {
          const hit = db.rows.find((r) => r.session_id === sessionId && r.id === id);

          return hit ? { hit: 1 } : undefined;
        },
      });
    }

    if (trimmed.startsWith("INSERT OR IGNORE INTO artifacts")) {
      return statement({
        run(...args) {
          db.insert(args, true);

          return undefined;
        },
      });
    }

    if (trimmed.startsWith("INSERT INTO artifacts")) {
      return statement({
        run(...args) {
          db.insert(args, false);

          return undefined;
        },
      });
    }

    if (trimmed.startsWith("SELECT id, tool_name, bytes, lines, ts FROM artifacts WHERE session_id = ? AND id = ?")) {
      return statement({
        get(sessionId, id) {
          const row = db.rows.find((r) => r.session_id === sessionId && r.id === id);

          return row ? meta(row) : undefined;
        },
      });
    }

    if (trimmed.startsWith("SELECT content FROM artifacts")) {
      return statement({
        get(sessionId, id) {
          const row = db.rows.find((r) => r.session_id === sessionId && r.id === id);

          return row ? { content: row.content } : undefined;
        },
      });
    }

    if (trimmed.startsWith("SELECT id, tool_name, bytes, lines, ts FROM artifacts WHERE session_id = ? ORDER BY ts DESC")) {
      return statement({
        all(sessionId) {
          return db.rows
            .filter((r) => r.session_id === sessionId)
            .sort((a, b) => b.ts - a.ts)
            .map(meta);
        },
      });
    }

    if (trimmed.startsWith("DELETE FROM artifacts WHERE session_id = ? AND id = ?")) {
      return statement({
        run(sessionId, id) {
          db.rows = db.rows.filter((r) => !(r.session_id === sessionId && r.id === id));

          return undefined;
        },
      });
    }

    if (trimmed.startsWith("DELETE FROM artifacts WHERE ts < ?")) {
      return statement({
        run(cutoff) {
          db.rows = db.rows.filter((r) => r.ts >= (cutoff as number));

          return undefined;
        },
      });
    }

    throw new Error(`unexpected sql: ${trimmed}`);
  }

  private insert(args: Array<string | number | null | Uint8Array>, ignore: boolean): void {
    const [session_id, id, tool_name, bytes, lines, ts, content] = args;
    const exists = this.rows.some((r) => r.session_id === session_id && r.id === id);

    if (exists) {
      if (ignore) {
        return;
      }

      throw new Error("UNIQUE constraint failed");
    }

    this.rows.push({
      session_id: session_id as string,
      id: id as string,
      tool_name: tool_name as string,
      bytes: bytes as number,
      lines: lines as number,
      ts: ts as number,
      content: content as Uint8Array,
    });
  }
}

function meta(row: Row): Record<string, unknown> {
  return { id: row.id, tool_name: row.tool_name, bytes: row.bytes, lines: row.lines, ts: row.ts };
}

function statement(impl: Partial<SqlStatement>): SqlStatement {
  return {
    run: impl.run ?? (() => undefined),
    get: impl.get ?? (() => undefined),
    all: impl.all ?? (() => []),
  };
}

function sourceOf(file: unknown): SessionSource {
  return { sessionManager: { getSessionFile: () => file } };
}

function newStore(): { store: ArtifactStore; db: FakeDb } {
  const db = new FakeDb();

  return { store: new ArtifactStore(() => db), db };
}

describe("session id resolution", () => {
  test("strips directory and extension", () => {
    const { store } = newStore();
    expect(store.resolveSessionId(sourceOf("/home/u/.pi/agent/sessions/abc123.jsonl"))).toBe("abc123");
  });

  test("replaces illegal characters", () => {
    const { store } = newStore();
    expect(store.resolveSessionId(sourceOf("/x/wei rd:name*.jsonl"))).toBe("wei-rd-name-");
  });

  test("strips leading dots and falls back when empty", () => {
    const { store } = newStore();
    const id = store.resolveSessionId(sourceOf("/x/...jsonl"));
    expect(id).toMatch(/^unsaved-[0-9a-f]{8}$/);
  });

  test("throwing getSessionFile yields stable fallback", () => {
    const { store } = newStore();
    const bad: SessionSource = {
      sessionManager: {
        getSessionFile() {
          throw new Error("boom");
        },
      },
    };
    const id = store.resolveSessionId(bad);
    expect(id).toMatch(/^unsaved-[0-9a-f]{8}$/);
  });

  test("dotfile without stem keeps the name", () => {
    const { store } = newStore();
    expect(store.resolveSessionId(sourceOf("/x/.hidden"))).toBe("hidden");
  });
});

describe("spill and retrieve roundtrip", () => {
  test("spill stores compressed content and returns a record", () => {
    const { store, db } = newStore();
    const src = sourceOf("/s/sess.jsonl");
    const record = store.spill(src, "bash", "hello\nworld\n");
    expect(record).not.toBeNull();
    expect(record?.toolName).toBe("bash");
    expect(record?.lines).toBe(2);
    expect(record?.bytes).toBe(Buffer.byteLength("hello\nworld\n"));
    expect(record?.id).toMatch(/^[0-9a-f]{8}$/);
    expect(db.rows.length).toBe(1);

    const read = store.read(src, record!.id);
    expect(read).toBe("hello\nworld\n");

    const meta = store.get(src, record!.id);
    expect(meta?.id).toBe(record!.id);
  });

  test("blank tool name is stored as unknown", () => {
    const { store } = newStore();
    const src = sourceOf("/s/sess.jsonl");
    const record = store.spill(src, "   ", "data");
    expect(record?.toolName).toBe("unknown");
  });

  test("get and read return absent markers for missing ids", () => {
    const { store } = newStore();
    const src = sourceOf("/s/sess.jsonl");
    expect(store.get(src, "deadbeef")).toBeUndefined();
    expect(store.read(src, "deadbeef")).toBeNull();
  });

  test("list orders by ts desc within session", () => {
    const { store, db } = newStore();
    const src = sourceOf("/s/sess.jsonl");
    store.spill(src, "a", "one");
    store.spill(src, "b", "two");
    db.rows[0].ts = 1000;
    db.rows[1].ts = 2000;
    const list = store.list(src);
    expect(list.map((r) => r.toolName)).toEqual(["b", "a"]);
  });

  test("artifacts are isolated by session id", () => {
    const { store, db } = newStore();
    const first = sourceOf("/s/one.jsonl");
    const second = sourceOf("/s/two.jsonl");
    store.spill(first, "a", "data");
    expect(store.list(first).length).toBe(1);
    expect(store.list(second).length).toBe(0);
    expect(db.rows.length).toBe(1);
  });

  test("remove deletes within session", () => {
    const { store } = newStore();
    const src = sourceOf("/s/sess.jsonl");
    const record = store.spill(src, "a", "data");
    store.attach(src);
    store.remove(record!.id);
    expect(store.get(src, record!.id)).toBeUndefined();
  });

  test("prune deletes stale rows and vacuums", () => {
    const { store, db } = newStore();
    const src = sourceOf("/s/sess.jsonl");
    store.spill(src, "a", "old");
    db.rows[0].ts = Date.now() - 30 * 86400000;
    store.prune(7);
    expect(db.rows.length).toBe(0);
    expect(db.execed).toContain("PRAGMA incremental_vacuum");
  });

  test("corrupt blob read returns null", () => {
    const { store, db } = newStore();
    const src = sourceOf("/s/sess.jsonl");
    const record = store.spill(src, "a", "data");
    const row = db.rows.find((r) => r.id === record!.id)!;
    row.content = new Uint8Array([1, 2, 3, 4]);
    expect(store.read(src, record!.id)).toBeNull();
  });
});

describe("degraded mode when sqlite is unavailable", () => {
  function failing(): ArtifactStore {
    return new ArtifactStore(() => {
      throw new Error("no sqlite");
    });
  }

  test("spill returns null", () => {
    expect(failing().spill(sourceOf("/s/x.jsonl"), "a", "data")).toBeNull();
  });

  test("get returns undefined and read returns null and list empty", () => {
    const store = failing();
    const src = sourceOf("/s/x.jsonl");
    expect(store.get(src, "x")).toBeUndefined();
    expect(store.read(src, "x")).toBeNull();
    expect(store.list(src)).toEqual([]);
  });

  test("opener is only invoked once even after failure", () => {
    let calls = 0;
    const store = new ArtifactStore(() => {
      calls += 1;
      throw new Error("nope");
    });
    const src = sourceOf("/s/x.jsonl");
    store.spill(src, "a", "data");
    store.list(src);
    store.get(src, "x");
    expect(calls).toBe(1);
  });
});

describe("prepared statement caching", () => {
  test("repeated reads reuse one prepared statement per sql", () => {
    let prepareCount = 0;
    const real = new FakeDb();
    const wrapped: SqlDatabase = {
      exec: (sql) => real.exec(sql),
      prepare: (sql) => {
        prepareCount += 1;

        return real.prepare(sql);
      },
    };
    const store = new ArtifactStore(() => wrapped);
    const src = sourceOf("/s/sess.jsonl");
    const record = store.spill(src, "a", "data");
    store.read(src, record!.id);
    const baseline = prepareCount;
    store.read(src, record!.id);
    store.read(src, record!.id);
    store.read(src, record!.id);
    expect(prepareCount).toBe(baseline);
  });
});

describe("Spiller.decide", () => {
  const config = Config.fromMerged({ spillBytes: 1024, headLines: 1, tailLines: 1 });

  test("skips configured tools", () => {
    const { store } = newStore();
    const spiller = new Spiller(store, Config.fromMerged({ skipTools: ["bash"], spillBytes: 1024 }));
    expect(spiller.decide("bash", [{ type: "text", text: "x".repeat(5000) }], sourceOf("/s/x.jsonl"))).toBeUndefined();
  });

  test("non-array content returns undefined", () => {
    const { store } = newStore();
    const spiller = new Spiller(store, config);
    expect(spiller.decide("grep", "nope", sourceOf("/s/x.jsonl"))).toBeUndefined();
  });

  test("small text blocks pass through unchanged", () => {
    const { store } = newStore();
    const spiller = new Spiller(store, config);
    expect(spiller.decide("grep", [{ type: "text", text: "tiny" }], sourceOf("/s/x.jsonl"))).toBeUndefined();
  });

  test("equal-to-threshold is not spilled", () => {
    const { store } = newStore();
    const spiller = new Spiller(store, config);
    const exact = "y".repeat(1024);
    expect(spiller.decide("grep", [{ type: "text", text: exact }], sourceOf("/s/x.jsonl"))).toBeUndefined();
  });

  test("oversized text block is replaced with a banner", () => {
    const { store, db } = newStore();
    const spiller = new Spiller(store, config);
    const big = Array.from({ length: 10 }, (_, i) => `row-${i}-${"z".repeat(200)}`).join("\n");
    const result = spiller.decide("grep", [{ type: "text", text: big }], sourceOf("/s/x.jsonl"));
    expect(result).not.toBeUndefined();
    const block = result!.content[0] as { type: string; text: string };
    expect(block.text).toContain("[output spilled to artifact");
    expect(db.rows.length).toBe(1);
  });

  test("non-text blocks pass through and only oversized text spills", () => {
    const { store } = newStore();
    const spiller = new Spiller(store, config);
    const big = "w".repeat(5000);
    const content = [{ type: "image", data: "..." }, { type: "text", text: big }, { type: "text", text: "small" }];
    const result = spiller.decide("grep", content, sourceOf("/s/x.jsonl"));
    expect(result).not.toBeUndefined();
    expect(result!.content[0]).toEqual({ type: "image", data: "..." });
    expect((result!.content[1] as { text: string }).text).toContain("spilled to artifact");
    expect(result!.content[2]).toEqual({ type: "text", text: "small" });
  });

  test("resolves session once per decide and reuses it for all blocks", () => {
    const { store, db } = newStore();
    const spiller = new Spiller(store, config);
    let calls = 0;
    const src: SessionSource = {
      sessionManager: {
        getSessionFile() {
          calls += 1;

          return "/s/sess.jsonl";
        },
      },
    };
    const big = "v".repeat(5000);
    spiller.decide("grep", [{ type: "text", text: big }, { type: "text", text: big }], src);
    expect(calls).toBe(1);
    expect(db.rows.length).toBe(2);
  });

  test("legacy compressed blob can be read back", () => {
    const { store, db } = newStore();
    const src = sourceOf("/s/sess.jsonl");
    store.attach(src);
    db.rows.push({
      session_id: store.resolveSessionId(src),
      id: "0a1b2c3d",
      tool_name: "bash",
      bytes: 5,
      lines: 1,
      ts: Date.now(),
      content: zstdCompressSync(Buffer.from("hello", "utf8")),
    });
    expect(store.read(src, "0a1b2c3d")).toBe("hello");
  });
});
