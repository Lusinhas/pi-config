import { describe, expect, test } from "bun:test";
import { StyleStore } from "../../src/styles/catalog.ts";
import type { DirectoryReader, DirEntry, DirListing } from "../../src/styles/parse.ts";
import { FrontmatterParser, StyleFileParser } from "../../src/styles/parse.ts";
import { ActivePersister } from "../../src/styles/persist.ts";
import type { StylesConfig } from "../../src/styles/config.ts";
import { StyleEngine, type ConfigSource, type SuiteFile, type SuiteRead } from "../../src/styles/index.ts";
import { Renderer } from "../../src/styles/render.ts";

const PRESET_DIR = "/presets";

function entry(path: string, name: string, source: "preset" | "user", body = "body text"): DirEntry {
  return { path, content: `---\nname: ${name}\ndescription: ${name} description\n---\n${body}`, readError: null };
}

class FakeReader implements DirectoryReader {
  constructor(private userListing: DirListing, private presetListing: DirListing = { entries: [], error: null }) {}

  list(dir: string): DirListing {
    return dir === PRESET_DIR ? this.presetListing : this.userListing;
  }

  fingerprint(): string {
    return String(this.userListing.entries.length);
  }

  setListing(listing: DirListing): void {
    this.userListing = listing;
  }
}

class FakeConfigSource implements ConfigSource {
  constructor(public config: StylesConfig) {}

  load(): StylesConfig {
    return this.config;
  }
}

class FakeSuite implements SuiteFile {
  raw: string | null = null;
  readOk = true;
  writeOk = true;
  written: string[] = [];

  read(): SuiteRead {
    return { ok: this.readOk, content: this.raw };
  }

  write(content: string): boolean {
    if (!this.writeOk) {
      return false;
    }

    this.written.push(content);
    this.raw = content;

    return true;
  }
}

interface Harness {
  engine: StyleEngine;
  suite: FakeSuite;
  reader: FakeReader;
  configSource: FakeConfigSource;
}

function harness(active: string, userEntries: DirEntry[], presets: DirEntry[] = [], userDir = "/styles"): Harness {
  const reader = new FakeReader({ entries: userEntries, error: null }, { entries: presets, error: null });
  const store = new StyleStore(new StyleFileParser(new FrontmatterParser()), reader, PRESET_DIR);
  const suite = new FakeSuite();
  const configSource = new FakeConfigSource({ active, userDir });
  const engine = new StyleEngine(store, new Renderer(), new ActivePersister(), suite, configSource, { active, userDir });

  return { engine, suite, reader, configSource };
}

describe("StyleEngine.addendum", () => {
  test("appends active style under heading", () => {
    const h = harness("foo", [entry("/u/foo.md", "foo", "user", "do it")]);
    expect(h.engine.addendum("BASE")).toEqual({ systemPrompt: "BASE\n\n## Output style: foo\n\ndo it" });
  });

  test("addendum alone when incoming empty", () => {
    const h = harness("foo", [entry("/u/foo.md", "foo", "user", "X")]);
    expect(h.engine.addendum("")).toEqual({ systemPrompt: "## Output style: foo\n\nX" });
  });

  test("non-string incoming treated as empty", () => {
    const h = harness("foo", [entry("/u/foo.md", "foo", "user", "X")]);
    expect(h.engine.addendum(undefined)).toEqual({ systemPrompt: "## Output style: foo\n\nX" });
  });

  test("returns undefined when active is off (case-insensitive)", () => {
    const h = harness("OFF", [entry("/u/foo.md", "foo", "user")]);
    expect(h.engine.addendum("BASE")).toBeUndefined();
  });

  test("returns undefined when active not in catalog", () => {
    const h = harness("ghost", [entry("/u/foo.md", "foo", "user")]);
    expect(h.engine.addendum("BASE")).toBeUndefined();
  });

  test("active lookup is case-insensitive", () => {
    const h = harness("FOO", [entry("/u/foo.md", "Foo", "user", "B")]);
    expect(h.engine.addendum("")).toEqual({ systemPrompt: "## Output style: Foo\n\nB" });
  });
});

describe("StyleEngine.apply", () => {
  test("off persisted yields disabled info notice", () => {
    const h = harness("foo", [entry("/u/foo.md", "foo", "user")]);
    expect(h.engine.apply("off")).toEqual({ message: "Output style disabled.", level: "info" });
    expect(JSON.parse(h.suite.written[0]).styles.active).toBe("off");
  });

  test("off not persisted yields warning", () => {
    const h = harness("foo", [entry("/u/foo.md", "foo", "user")]);
    h.suite.writeOk = false;
    expect(h.engine.apply("off")).toEqual({
      message: "Output style disabled for this session; could not persist to ~/.pi/agent/suite.json.",
      level: "warning",
    });
  });

  test("unknown with some available lists names then off", () => {
    const h = harness("foo", [entry("/u/a.md", "alpha", "user"), entry("/u/b.md", "beta", "user")]);
    expect(h.engine.apply("ghost")).toEqual({
      message: 'Unknown style "ghost". Available: alpha, beta, off',
      level: "error",
    });
  });

  test("unknown with none available", () => {
    const h = harness("foo", []);
    expect(h.engine.apply("ghost")).toEqual({
      message: 'Unknown style "ghost" and no styles are available.',
      level: "error",
    });
  });

  test("applied persisted reports name and source", () => {
    const h = harness("off", [entry("/u/foo.md", "foo", "user")]);
    expect(h.engine.apply("FOO")).toEqual({ message: "Output style: foo (user)", level: "info" });
    expect(JSON.parse(h.suite.written[0]).styles.active).toBe("foo");
  });

  test("applied but not persisted yields warning with original-case name", () => {
    const h = harness("off", [entry("/u/foo.md", "Foo", "user")]);
    h.suite.writeOk = false;
    expect(h.engine.apply("foo")).toEqual({
      message: "Output style Foo applied for this session; could not persist to ~/.pi/agent/suite.json.",
      level: "warning",
    });
  });

  test("non-ENOENT read failure prevents persistence", () => {
    const h = harness("off", [entry("/u/foo.md", "foo", "user")]);
    h.suite.readOk = false;
    expect(h.engine.apply("foo").level).toBe("warning");
    expect(h.suite.written).toEqual([]);
  });
});

describe("StyleEngine.applyMenuChoice", () => {
  test("undefined choice returns null (no apply)", () => {
    const h = harness("foo", [entry("/u/foo.md", "foo", "user")]);
    const menu = h.engine.menu();
    expect(h.engine.applyMenuChoice(menu, undefined)).toBeNull();
  });

  test("choice not in options returns null", () => {
    const h = harness("foo", [entry("/u/foo.md", "foo", "user")]);
    const menu = h.engine.menu();
    expect(h.engine.applyMenuChoice(menu, "not a real option")).toBeNull();
  });

  test("valid choice maps to parallel value and applies", () => {
    const h = harness("off", [entry("/u/foo.md", "foo", "user")]);
    const menu = h.engine.menu();
    const notice = h.engine.applyMenuChoice(menu, menu.options[0]);
    expect(notice).toEqual({ message: "Output style: foo (user)", level: "info" });
  });

  test("selecting off option disables", () => {
    const h = harness("foo", [entry("/u/foo.md", "foo", "user")]);
    const menu = h.engine.menu();
    const offOption = menu.options[menu.values.indexOf("off")];
    expect(h.engine.applyMenuChoice(menu, offOption)).toEqual({ message: "Output style disabled.", level: "info" });
  });
});

describe("StyleEngine lifecycle", () => {
  test("reloadConfig updates active and userDir and refreshes catalog", () => {
    const h = harness("foo", [entry("/u/foo.md", "foo", "user")]);
    h.configSource.config = { active: "bar", userDir: "/other" };
    h.reader.setListing({ entries: [entry("/o/bar.md", "bar", "user", "BB")], error: null });
    h.engine.reloadConfig();
    expect(h.engine.addendum("")).toEqual({ systemPrompt: "## Output style: bar\n\nBB" });
  });

  test("onResourcesDiscover refreshes only on reload reason", () => {
    const h = harness("foo", [entry("/u/foo.md", "foo", "user")]);
    h.reader.setListing({ entries: [entry("/u/foo.md", "foo", "user"), entry("/u/new.md", "newstyle", "user")], error: null });
    h.engine.onResourcesDiscover("startup");
    expect(h.engine.completions("new")).toBeNull();
    h.engine.onResourcesDiscover("reload");
    expect(h.engine.completions("new")?.map((i) => i.value)).toEqual(["newstyle"]);
  });

  test("notices reflect current catalog and active", () => {
    const h = harness("ghost", [entry("/u/foo.md", "foo", "user")]);
    expect(h.engine.notices()).toBe(
      'Styles: active style "ghost" was not found; no style addendum is being applied.',
    );
  });

  test("preset and user tiers both feed completions in order", () => {
    const h = harness("default", [entry("/u/zeta.md", "zeta", "user")], [entry("/p/default.md", "default", "preset")]);
    expect(h.engine.completions("")?.map((i) => i.value)).toEqual(["default", "zeta", "off"]);
  });
});
