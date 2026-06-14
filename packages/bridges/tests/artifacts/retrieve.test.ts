import { describe, expect, test } from "bun:test";
import { type ArtifactRecord, type SessionSource } from "../../src/artifacts/index.ts";
import type { ArtifactsConfig } from "../../src/artifacts/render.ts";
import { Retrieve } from "../../src/artifacts/retrieve.ts";

const config: ArtifactsConfig = {
  spillBytes: 30720,
  headLines: 40,
  tailLines: 20,
  skipTools: ["artifact"],
  maxAgeDays: 7,
  retrieveLines: 200,
};

const source: SessionSource = { sessionManager: { getSessionFile: () => "/tmp/session.jsonl" } };

class FakeStore {
  removed: string[] = [];

  constructor(
    private readonly records: Map<string, ArtifactRecord>,
    private readonly texts: Map<string, string | (() => string)>,
  ) {}

  list(): ArtifactRecord[] {
    return [...this.records.values()].sort((a, b) => b.ts - a.ts);
  }

  get(_source: SessionSource, id: string): ArtifactRecord | undefined {
    return this.records.get(id);
  }

  read(_source: SessionSource, id: string): string | null {
    const value = this.texts.get(id);

    if (value === undefined) {
      return null;
    }

    return typeof value === "function" ? value() : value;
  }

  remove(id: string): void {
    this.removed.push(id);
  }
}

function rec(over: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return { id: "aabbccdd", toolName: "bash", bytes: 50, lines: 5, ts: Date.now(), ...over };
}

describe("normalizeOption", () => {
  test("undefined returns fallback", () => {
    expect(Retrieve.normalizeOption(undefined, 7, "offset")).toBe(7);
  });

  test("non-finite throws", () => {
    expect(() => Retrieve.normalizeOption(Number.NaN, 1, "offset")).toThrow("offset must be a finite number");
  });

  test("below one throws", () => {
    expect(() => Retrieve.normalizeOption(0, 1, "limit")).toThrow("limit must be at least 1");
  });

  test("floors valid value", () => {
    expect(Retrieve.normalizeOption(3.9, 1, "offset")).toBe(3);
  });
});

describe("execute id validation", () => {
  test("empty id throws", () => {
    const r = new Retrieve(new FakeStore(new Map(), new Map()), config);
    expect(() => r.execute(source, { id: "  " })).toThrow("artifact requires an id");
  });

  test("unknown id throws", () => {
    const r = new Retrieve(new FakeStore(new Map(), new Map()), config);
    expect(() => r.execute(source, { id: "nope" })).toThrow('unknown artifact id "nope"');
  });

  test("null read removes and throws pruned message", () => {
    const store = new FakeStore(new Map([["aabbccdd", rec()]]), new Map());
    const r = new Retrieve(store, config);
    expect(() => r.execute(source, { id: "aabbccdd" })).toThrow("is no longer readable (pruned or deleted)");
    expect(store.removed).toEqual(["aabbccdd"]);
  });

  test("unreadable artifact removes and reports the pruned-or-deleted path", () => {
    const store = new FakeStore(new Map([["aabbccdd", rec()]]), new Map([["aabbccdd", () => null as unknown as string]]));
    const r = new Retrieve(store, config);
    expect(() => r.execute(source, { id: "aabbccdd" })).toThrow("is no longer readable (pruned or deleted)");
    expect(store.removed).toEqual(["aabbccdd"]);
  });
});

describe("buildList", () => {
  test("empty session message", () => {
    const r = new Retrieve(new FakeStore(new Map(), new Map()), config);
    const result = r.execute(source, { id: "list" });
    expect(result.content[0].text).toBe(
      "No artifacts in this session. Oversized tool outputs are spilled here automatically.",
    );
    expect(result.details).toEqual({ count: 0 });
  });

  test("table ordering, padding and summary", () => {
    const records = new Map<string, ArtifactRecord>([
      ["11111111", rec({ id: "11111111", toolName: "bash", bytes: 2048, lines: 10, ts: 1000 })],
      ["22222222", rec({ id: "22222222", toolName: "grepverylong", bytes: 100, lines: 3, ts: 2000 })],
    ]);
    const r = new Retrieve(new FakeStore(records, new Map()), config);
    const result = r.execute(source, { id: "LIST" });
    const lines = result.content[0].text.split("\n");
    expect(lines[0]).toBe("id        tool          size    lines  age");
    expect(lines[1]).toContain("22222222");
    expect(lines[2]).toContain("11111111");
    expect(result.content[0].text).toContain("2 artifacts in this session.");
    expect((result.details as { count: number }).count).toBe(2);
  });

  test("single artifact singular summary", () => {
    const records = new Map<string, ArtifactRecord>([["11111111", rec({ id: "11111111" })]]);
    const r = new Retrieve(new FakeStore(records, new Map()), config);
    const result = r.execute(source, { id: "list" });
    expect(result.content[0].text).toContain("1 artifact in this session.");
  });
});

describe("buildWindow", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");

  function store(): FakeStore {
    return new FakeStore(
      new Map([["aabbccdd", rec({ lines: 10, bytes: Buffer.byteLength(text) })]]),
      new Map([["aabbccdd", text]]),
    );
  }

  test("default window from start to end", () => {
    const r = new Retrieve(store(), config);
    const result = r.execute(source, { id: "aabbccdd" });
    expect(result.content[0].text).toContain("artifact aabbccdd (bash) — lines 1-10 of 10");
    expect(result.content[0].text).toContain(" 1: line-1");
    expect(result.content[0].text).toContain("10: line-10");
    expect(result.content[0].text).toContain("(end of artifact)");
    expect(result.details).toMatchObject({ offset: 1, returnedThrough: 10, totalLines: 10, remainingLines: 0 });
  });

  test("offset past end throws", () => {
    const r = new Retrieve(store(), config);
    expect(() => r.execute(source, { id: "aabbccdd", offset: 11 })).toThrow(
      'offset 11 is past the end of artifact "aabbccdd" (10 lines total)',
    );
  });

  test("limit produces remaining and continue note", () => {
    const r = new Retrieve(store(), config);
    const result = r.execute(source, { id: "aabbccdd", offset: 1, limit: 3 });
    expect(result.content[0].text).toContain("lines 1-3 of 10");
    expect(result.content[0].text).toContain('7 lines remaining; continue with {"id":"aabbccdd","offset":4}');
    expect(result.details).toMatchObject({ returnedThrough: 3, remainingLines: 7 });
  });

  test("byte budget clip stops early with note", () => {
    const long = Array.from({ length: 5 }, () => "z".repeat(2000)).join("\n");
    const s = new FakeStore(
      new Map([["aabbccdd", rec({ lines: 5, bytes: Buffer.byteLength(long) })]]),
      new Map([["aabbccdd", long]]),
    );
    const cfg: ArtifactsConfig = { ...config, spillBytes: 4096 };
    const r = new Retrieve(s, cfg);
    const result = r.execute(source, { id: "aabbccdd", offset: 1, limit: 5 });
    expect(result.content[0].text).toContain("window clipped at");
    expect((result.details as { returnedThrough: number }).returnedThrough).toBeLessThan(5);
  });

  test("first-line clip stays within budget including suffix", () => {
    const huge = "q".repeat(20000);
    const s = new FakeStore(
      new Map([["aabbccdd", rec({ lines: 1, bytes: Buffer.byteLength(huge) })]]),
      new Map([["aabbccdd", huge]]),
    );
    const cfg: ArtifactsConfig = { ...config, spillBytes: 4096 };
    const r = new Retrieve(s, cfg);
    const result = r.execute(source, { id: "aabbccdd", offset: 1, limit: 1 });
    const body = result.content[0].text.split("\n\n")[1];
    expect(body).toContain("[line clipped]");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(4096);
    expect((result.details as { returnedThrough: number }).returnedThrough).toBe(1);
  });

  test("singular remaining line wording", () => {
    const r = new Retrieve(store(), config);
    const result = r.execute(source, { id: "aabbccdd", offset: 1, limit: 9 });
    expect(result.content[0].text).toContain('1 line remaining; continue with {"id":"aabbccdd","offset":10}');
  });
});
