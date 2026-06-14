import { describe, expect, test } from "bun:test";
import { StyleStore } from "../../src/styles/catalog.ts";
import type { DirEntry, DirectoryReader, DirListing } from "../../src/styles/parse.ts";
import { FrontmatterParser, StyleFileParser, type StyleError } from "../../src/styles/parse.ts";

const PRESET_DIR = "/presets";

function entry(path: string, content: string): DirEntry {
  return { path, content, readError: null };
}

function style(name: string, body = "body text"): string {
  return `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}`;
}

class FakeReader implements DirectoryReader {
  constructor(private userListing: DirListing, private presetListing: DirListing = { entries: [], error: null }, private fp = "fp") {}

  list(dir: string): DirListing {
    return dir === PRESET_DIR ? this.presetListing : this.userListing;
  }

  fingerprint(): string {
    return this.fp;
  }

  setFingerprint(fp: string): void {
    this.fp = fp;
  }

  setListing(listing: DirListing): void {
    this.userListing = listing;
  }
}

function makeStore(presetListing: DirListing, reader: DirectoryReader): StyleStore {
  return new StyleStore(new StyleFileParser(new FrontmatterParser()), reader, PRESET_DIR);
}

describe("StyleStore.discover", () => {
  test("merges presets and user styles in fixed tier order", () => {
    const presetListing: DirListing = { entries: [entry("/presets/default.md", style("default"))], error: null };
    const reader = new FakeReader({ entries: [entry("/u/extra.md", style("extra"))], error: null }, presetListing);
    const catalog = makeStore(presetListing, reader).discover("/u");
    expect(catalog.get("default")?.source).toBe("preset");
    expect(catalog.get("extra")?.source).toBe("user");
    expect(catalog.problems).toEqual([]);
  });

  test("user tier overrides preset of same key silently", () => {
    const presetListing: DirListing = { entries: [entry("/presets/default.md", style("default", "preset body"))], error: null };
    const reader = new FakeReader({ entries: [entry("/u/default.md", style("default", "user body"))], error: null }, presetListing);
    const catalog = makeStore(presetListing, reader).discover("/u");
    const resolved = catalog.get("default");
    expect(resolved?.source).toBe("user");
    expect(resolved?.body).toBe("user body");
    expect(catalog.problems).toEqual([]);
  });

  test("name case is preserved while key is lowercased", () => {
    const presetListing: DirListing = { entries: [entry("/p/m.md", style("MixedCase"))], error: null };
    const reader = new FakeReader({ entries: [], error: null }, presetListing);
    const catalog = makeStore(presetListing, reader).discover("/u");
    expect(catalog.has("mixedcase")).toBe(true);
    expect(catalog.get("MIXEDCASE")?.name).toBe("MixedCase");
  });

  test("same-source duplicate name produces error and skips later", () => {
    const reader = new FakeReader({
      entries: [entry("/u/a.md", style("dup", "first")), entry("/u/b.md", style("dup", "second"))],
      error: null,
    });
    const catalog = makeStore({ entries: [], error: null }, reader).discover("/u");
    expect(catalog.get("dup")?.body).toBe("first");
    expect(catalog.problems).toEqual([
      { path: "/u/b.md", message: 'duplicate style name "dup" (already defined by /u/a.md)' },
    ]);
  });

  test("parse errors accumulate as StyleError entries", () => {
    const reader = new FakeReader({
      entries: [entry("/u/bad.md", "no frontmatter"), entry("/u/good.md", style("good"))],
      error: null,
    });
    const catalog = makeStore({ entries: [], error: null }, reader).discover("/u");
    expect(catalog.has("good")).toBe(true);
    expect(catalog.problems).toEqual([{ path: "/u/bad.md", message: "missing frontmatter opening delimiter" }]);
  });

  test("unreadable individual file becomes a per-file error", () => {
    const reader = new FakeReader({
      entries: [{ path: "/u/x.md", content: null, readError: "EACCES" }, entry("/u/y.md", style("y"))],
      error: null,
    });
    const catalog = makeStore({ entries: [], error: null }, reader).discover("/u");
    expect(catalog.problems).toEqual([{ path: "/u/x.md", message: "unreadable: EACCES" }]);
    expect(catalog.has("y")).toBe(true);
  });

  test("directory-level error is surfaced", () => {
    const dirError: StyleError = { path: "/u", message: "unreadable directory: boom" };
    const reader = new FakeReader({ entries: [], error: dirError });
    const catalog = makeStore({ entries: [], error: null }, reader).discover("/u");
    expect(catalog.problems).toEqual([dirError]);
  });

  test("preset duplicate within preset tier is an error", () => {
    const presetListing: DirListing = {
      entries: [entry("/p/a.md", style("same", "1")), entry("/p/b.md", style("same", "2"))],
      error: null,
    };
    const reader = new FakeReader({ entries: [], error: null }, presetListing);
    const catalog = makeStore(presetListing, reader).discover("/u");
    expect(catalog.problems).toEqual([
      { path: "/p/b.md", message: 'duplicate style name "same" (already defined by /p/a.md)' },
    ]);
  });

  test("newly added preset is picked up via the shared reader path", () => {
    const presetListing: DirListing = { entries: [entry("/presets/new.md", style("freshpreset"))], error: null };
    const reader = new FakeReader({ entries: [], error: null }, presetListing);
    const catalog = makeStore(presetListing, reader).discover("/u");
    expect(catalog.get("freshpreset")?.source).toBe("preset");
  });
});

describe("StyleStore caching", () => {
  test("returns same catalog when fingerprint unchanged", () => {
    const reader = new FakeReader({ entries: [entry("/u/a.md", style("a"))], error: null }, { entries: [], error: null }, "v1");
    const store = makeStore({ entries: [], error: null }, reader);
    const first = store.discover("/u");
    const second = store.discover("/u");
    expect(second).toBe(first);
  });

  test("rebuilds when fingerprint changes (freshness)", () => {
    const reader = new FakeReader({ entries: [entry("/u/a.md", style("a"))], error: null }, { entries: [], error: null }, "v1");
    const store = makeStore({ entries: [], error: null }, reader);
    const first = store.discover("/u");
    reader.setListing({ entries: [entry("/u/a.md", style("a")), entry("/u/b.md", style("b"))], error: null });
    reader.setFingerprint("v2");
    const second = store.discover("/u");
    expect(second).not.toBe(first);
    expect(second.has("b")).toBe(true);
  });

  test("rebuilds when userDir changes even with same fingerprint", () => {
    const reader = new FakeReader({ entries: [entry("/u/a.md", style("a"))], error: null }, { entries: [], error: null }, "same");
    const store = makeStore({ entries: [], error: null }, reader);
    const first = store.discover("/one");
    const second = store.discover("/two");
    expect(second).not.toBe(first);
  });
});
