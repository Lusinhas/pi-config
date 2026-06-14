import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/memory/index.ts";

const directQueue = async (_path: string, run: () => Promise<unknown>): Promise<unknown> => run();

function newStore(): Store {
  return new Store(directQueue);
}

describe("Store.slugify", () => {
  const store = newStore();

  it("lowercases, strips diacritics, and dashes non-alphanumerics", () => {
    expect(store.slugify("Café Setup")).toBe("cafe-setup");
    expect(store.slugify("Build & Test!!")).toBe("build-test");
  });

  it("trims leading and trailing dashes", () => {
    expect(store.slugify("  --hello-- ")).toBe("hello");
    expect(store.slugify("***edge***")).toBe("edge");
  });

  it("returns 'topic' for empty results", () => {
    expect(store.slugify("")).toBe("topic");
    expect(store.slugify("!!!")).toBe("topic");
    expect(store.slugify("---")).toBe("topic");
  });

  it("slices to 64 then strips a trailing dash produced by the cut", () => {
    const long = `${"a".repeat(63)}-bcd`;
    const slug = store.slugify(long);

    expect(slug.length).toBe(63);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("matches the pre-slice trim path when no post-cut dash appears", () => {
    expect(store.slugify("Topic Name Here")).toBe("topic-name-here");
  });

  it("strips leading dashes before slicing so the 64 window holds full alphanumerics", () => {
    expect(store.slugify(`!${"a".repeat(70)}`)).toBe("a".repeat(64));
    expect(store.slugify(`@@${"a".repeat(62)}bb`)).toBe(`${"a".repeat(62)}bb`);
  });
});

describe("Store.clip", () => {
  const store = newStore();

  it("returns text unchanged for non-positive budget or short text", () => {
    expect(store.clip("hello", 0)).toBe("hello");
    expect(store.clip("hello", -5)).toBe("hello");
    expect(store.clip("hello", 5)).toBe("hello");
    expect(store.clip("hello", 99)).toBe("hello");
  });

  it("cuts at the last newline inside the head when it is past the halfway point", () => {
    const text = `${"a".repeat(20)}\n${"b".repeat(40)}`;
    const out = store.clip(text, 40);

    expect(out.endsWith("\n[truncated]")).toBe(true);
    expect(out).toBe(`${"a".repeat(20)}\n[truncated]`);
  });

  it("keeps the head when no newline is past the halfway point", () => {
    const text = "x".repeat(100);
    const out = store.clip(text, 40);

    expect(out).toBe(`${"x".repeat(27)}\n[truncated]`);
  });
});

describe("Store.oneLine", () => {
  const store = newStore();

  it("removes brackets and parens and collapses whitespace", () => {
    expect(store.oneLine("a [b] (c)  d\n\te", 100)).toBe("a b c d e");
  });

  it("truncates with an ellipsis past max", () => {
    expect(store.oneLine("abcdef", 4)).toBe("abc…");
  });

  it("returns flat text at exactly max", () => {
    expect(store.oneLine("abcd", 4)).toBe("abcd");
  });
});

describe("Store.parseIndex and formatIndex", () => {
  const store = newStore();

  it("round-trips index lines with non-empty summaries", () => {
    const refs = [
      { slug: "build", title: "Build", summary: "how to build" },
      { slug: "run", title: "Run", summary: "how to run" },
    ];
    const text = store.formatIndex(refs);

    expect(text).toBe("- [Build](build.md) — how to build\n- [Run](run.md) — how to run\n");
    expect(store.parseIndex(text)).toEqual(refs);
  });

  it("emits an empty-summary line but cannot reparse it once trimmed", () => {
    const text = store.formatIndex([{ slug: "test", title: "Test", summary: "" }]);

    expect(text).toBe("- [Test](test.md) — \n");
    expect(store.parseIndex(text)).toEqual([]);
  });

  it("empty refs format to empty string", () => {
    expect(store.formatIndex([])).toBe("");
  });

  it("ignores lines that do not match the index regex", () => {
    expect(store.parseIndex("# heading\nrandom\n- [x](y.md) — z")).toEqual([
      { slug: "y", title: "x", summary: "z" },
    ]);
  });
});

describe("Store.capBytes", () => {
  const store = newStore();

  it("returns unchanged when within byte budget or non-positive", () => {
    expect(store.capBytes("short", 0, "T")).toBe("short");
    expect(store.capBytes("short", 100, "T")).toBe("short");
  });

  it("tail-truncates oversized ascii content and prepends the header", () => {
    const body = `# Title\n\n${"line\n".repeat(2000)}`;
    const out = store.capBytes(body, 4096, "Title");

    expect(out.startsWith("# Title\n\n")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(4096);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("strips a leading replacement char from a multibyte boundary split and drops the partial first line", () => {
    const head = "# T\n\n";
    const filler = "x".repeat(300);
    const body = `${head}${filler}\n€€€€€€€€€€\nlast line keeps clean\n`;
    const out = store.capBytes(body, 320, "T");

    expect(out.startsWith("# T\n\n")).toBe(true);
    expect(out.includes("�")).toBe(false);
    expect(out.endsWith("\n")).toBe(true);
  });
});

describe("Store topic filesystem lifecycle", () => {
  let dir: string;
  const store = newStore();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memstore-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readIndex falls back to empty string when missing", async () => {
    expect(await store.readIndex(dir)).toBe("");
  });

  it("saves a new topic, writes body and index, and reports created", async () => {
    const result = await store.saveTopic(dir, "Build Commands", "Run make all", 65536);

    expect(result.created).toBe(true);
    expect(result.slug).toBe("build-commands");

    const body = await readFile(join(dir, "build-commands.md"), "utf8");

    expect(body).toBe("# Build Commands\n\nRun make all\n");

    const index = await store.readIndex(dir);

    expect(index).toBe("- [Build Commands](build-commands.md) — Run make all\n");
  });

  it("appends to an existing topic and updates the index summary", async () => {
    await store.saveTopic(dir, "Notes", "First note", 65536);
    const second = await store.saveTopic(dir, "Notes", "Second note", 65536);

    expect(second.created).toBe(false);

    const body = await readFile(join(dir, "notes.md"), "utf8");

    expect(body).toBe("# Notes\n\nFirst note\n\nSecond note\n");

    const index = await store.readIndex(dir);

    expect(index).toBe("- [Notes](notes.md) — Second note\n");
  });

  it("rejects empty topic and empty text", async () => {
    await expect(store.saveTopic(dir, "   ", "x", 65536)).rejects.toThrow("non-empty topic");
    await expect(store.saveTopic(dir, "ok", "   ", 65536)).rejects.toThrow("non-empty text");
  });

  it("lists index topics first then orphan files sorted deterministically", async () => {
    await store.saveTopic(dir, "Zeta", "z", 65536);
    writeFileSync(join(dir, "orphanb.md"), "# orphanb\n");
    writeFileSync(join(dir, "orphana.md"), "# orphana\n");
    writeFileSync(join(dir, "MEMORY.md"), await store.readIndex(dir));

    const topics = await store.listTopics(dir);

    expect(topics.map((t) => t.slug)).toEqual(["zeta", "orphana", "orphanb"]);
  });

  it("resolves slug by direct file, by ref slug, and by title", async () => {
    await store.saveTopic(dir, "My Topic", "x", 65536);

    expect(await store.resolveSlug(dir, "My Topic")).toBe("my-topic");
    expect(await store.resolveSlug(dir, "my-topic")).toBe("my-topic");
    expect(await store.resolveSlug(dir, "MY TOPIC")).toBe("my-topic");
    expect(await store.resolveSlug(dir, "nope")).toBeUndefined();
  });

  it("readTopic returns undefined for unknown topic", async () => {
    expect(await store.readTopic(dir, "ghost")).toBeUndefined();
  });

  it("forgets a topic, removing file and index ref", async () => {
    await store.saveTopic(dir, "Gone", "x", 65536);

    expect(await store.forgetTopic(dir, "Gone")).toBe(true);
    expect(await store.readTopic(dir, "Gone")).toBeUndefined();
    expect(await store.readIndex(dir)).toBe("");
    expect(await store.forgetTopic(dir, "Gone")).toBe(false);
  });

  it("byte cap applies on save for tiny budgets", async () => {
    await store.saveTopic(dir, "Big", "x".repeat(10000), 4096);
    const body = await readFile(join(dir, "big.md"), "utf8");

    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("reflects a fresh save in the cached index without staleness", async () => {
    await store.saveTopic(dir, "Alpha", "first", 65536);

    expect((await store.listTopics(dir)).map((t) => t.slug)).toEqual(["alpha"]);

    await store.saveTopic(dir, "Beta", "second", 65536);

    expect((await store.listTopics(dir)).map((t) => t.slug)).toEqual(["alpha", "beta"]);
  });
});

describe("Store.memoryDir and projectRoot", () => {
  it("hashes the resolved cwd when no .git ancestor and caches the result", () => {
    const store = newStore();
    const dir = mkdtempSync(join(tmpdir(), "memroot-"));

    try {
      const root = store.projectRoot(dir);
      const again = store.projectRoot(dir);

      expect(again).toBe(root);

      const memDir = store.memoryDir(dir);

      expect(memDir.includes(join(".pi", "agent", "memory"))).toBe(true);
      expect(memDir.split(/[\\/]/).pop()).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
