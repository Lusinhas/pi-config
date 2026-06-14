import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FormatFlags } from "../../src/rules/settings.ts";
import { Frontmatter, RuleDiscovery, Semantics } from "../../src/rules/formats.ts";

const allFormats: FormatFlags = {
  pi: true,
  claude: true,
  cursor: true,
  copilot: true,
  windsurf: true,
  cline: true,
};

describe("Frontmatter", () => {
  const fm = new Frontmatter();

  test("no frontmatter yields whole text as body", () => {
    const result = fm.extract("hello world");

    expect(result.error).toBeNull();
    expect(result.body).toBe("hello world");
    expect(result.data).toEqual({});
  });

  test("strips BOM before checking delimiter", () => {
    const result = fm.extract("﻿---\nalwaysApply: true\n---\nbody");

    expect(result.error).toBeNull();
    expect(result.data.alwaysApply).toBe(true);
    expect(result.body).toBe("body");
  });

  test("unterminated frontmatter is an error with empty body", () => {
    const result = fm.extract("---\nfoo: bar\nno end here");

    expect(result.error).toBe("unterminated frontmatter");
    expect(result.body).toBe("");
  });

  test("terminator can be three dots", () => {
    const result = fm.extract("---\nfoo: bar\n...\nbody text");

    expect(result.error).toBeNull();
    expect(result.body).toBe("body text");
    expect(result.data.foo).toBe("bar");
  });

  test("inline array scalar parses quote and brace aware", () => {
    const result = fm.extract('---\nglobs: ["src/**/*.ts", "{a,b}/c.md"]\n---\nb');

    expect(result.data.globs).toEqual(["src/**/*.ts", "{a,b}/c.md"]);
  });

  test("block list parses dash items", () => {
    const result = fm.extract("---\npaths:\n  - one.md\n  - two.md\n---\nb");

    expect(result.data.paths).toEqual(["one.md", "two.md"]);
  });

  test("booleans and quoted strings", () => {
    const result = fm.extract(`---\nalwaysApply: false\nname: "quoted value"\n---\nb`);

    expect(result.data.alwaysApply).toBe(false);
    expect(result.data.name).toBe("quoted value");
  });

  test("comment lines and indented continuations ignored", () => {
    const result = fm.extract("---\n# a comment\nkey: value\n  indented: skip\n---\nb");

    expect(result.data.key).toBe("value");
    expect(result.data.indented).toBeUndefined();
  });

  test("empty inline array yields empty array", () => {
    const result = fm.extract("---\nglobs: []\n---\nb");

    expect(result.data.globs).toEqual([]);
  });
});

describe("Semantics", () => {
  const semantics = new Semantics(new Frontmatter());

  test("native: alwaysApply true means always", () => {
    expect(semantics.native({ alwaysApply: true })).toEqual({ scopes: [], always: true });
  });

  test("native: no scopes and undefined alwaysApply means always", () => {
    expect(semantics.native({})).toEqual({ scopes: [], always: true });
  });

  test("native: scopes present without alwaysApply means scoped", () => {
    expect(semantics.native({ globs: ["a/*.ts"] })).toEqual({ scopes: ["a/*.ts"], always: false });
  });

  test("native: unions paths and globs deduped", () => {
    expect(semantics.native({ paths: ["a", "b"], globs: ["b", "c"] }).scopes).toEqual(["a", "b", "c"]);
  });

  test("cursor: never auto-always when no scope", () => {
    expect(semantics.cursor({})).toEqual({ scopes: [], always: false });
    expect(semantics.cursor({ alwaysApply: true })).toEqual({ scopes: [], always: true });
    expect(semantics.cursor({ globs: "x/*.ts" })).toEqual({ scopes: ["x/*.ts"], always: false });
  });

  test("copilot: empty or universal applyTo means always", () => {
    expect(semantics.copilot({})).toEqual({ scopes: [], always: true });
    expect(semantics.copilot({ applyTo: ["**"] })).toEqual({ scopes: [], always: true });
    expect(semantics.copilot({ applyTo: ["**/*"] })).toEqual({ scopes: [], always: true });
    expect(semantics.copilot({ applyTo: ["src/**"] })).toEqual({ scopes: ["src/**"], always: false });
  });

  test("windsurf trigger table", () => {
    expect(semantics.windsurf({ trigger: "always_on" })).toEqual({ scopes: [], always: true });
    expect(semantics.windsurf({ trigger: "glob", globs: ["a/*"] })).toEqual({ scopes: ["a/*"], always: false });
    expect(semantics.windsurf({ trigger: "manual" })).toEqual({ scopes: [], always: false });
    expect(semantics.windsurf({ trigger: "model_decision" })).toEqual({ scopes: [], always: false });
    expect(semantics.windsurf({ alwaysApply: true })).toEqual({ scopes: [], always: true });
    expect(semantics.windsurf({ globs: ["a/*"] })).toEqual({ scopes: ["a/*"], always: false });
    expect(semantics.windsurf({})).toEqual({ scopes: [], always: true });
  });

  test("asBool accepts yes/no strings", () => {
    expect(semantics.asBool("yes")).toBe(true);
    expect(semantics.asBool("NO")).toBe(false);
    expect(semantics.asBool("maybe")).toBeUndefined();
  });
});

describe("RuleDiscovery", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rules-disc-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("discovers pi rules in deterministic sorted order", () => {
    const piDir = join(dir, ".pi", "rules");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "b.md"), "---\nalwaysApply: true\n---\nB body");
    writeFileSync(join(piDir, "a.md"), "---\nglobs: src/*.ts\n---\nA body");

    const result = new RuleDiscovery(allFormats).discover(dir);

    expect(result.errors).toEqual([]);
    expect(result.rules.map((r) => r.relPath)).toEqual([".pi/rules/a.md", ".pi/rules/b.md"]);
    expect(result.rules[0].always).toBe(false);
    expect(result.rules[1].always).toBe(true);
  });

  test("skips dotfiles and wrong suffixes", () => {
    const piDir = join(dir, ".pi", "rules");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, ".hidden.md"), "---\n---\nbody");
    writeFileSync(join(piDir, "note.txt"), "body");
    writeFileSync(join(piDir, "real.md"), "real body");

    const result = new RuleDiscovery(allFormats).discover(dir);

    expect(result.rules.map((r) => r.relPath)).toEqual([".pi/rules/real.md"]);
  });

  test("records empty body and unterminated frontmatter errors", () => {
    const piDir = join(dir, ".pi", "rules");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "empty.md"), "---\nalwaysApply: true\n---\n   ");
    writeFileSync(join(piDir, "broken.md"), "---\nfoo: bar");

    const result = new RuleDiscovery(allFormats).discover(dir);

    expect(result.rules).toEqual([]);
    const messages = result.errors.map((e) => `${e.relPath}:${e.message}`).sort();
    expect(messages).toEqual([".pi/rules/broken.md:unterminated frontmatter", ".pi/rules/empty.md:empty rule body"]);
  });

  test("format gating disables a source", () => {
    const piDir = join(dir, ".pi", "rules");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "a.md"), "body");

    const result = new RuleDiscovery({ ...allFormats, pi: false }).discover(dir);

    expect(result.rules).toEqual([]);
  });

  test("cline as a single file", () => {
    writeFileSync(join(dir, ".clinerules"), "cline body");

    const result = new RuleDiscovery(allFormats).discover(dir);

    expect(result.rules.map((r) => r.relPath)).toEqual([".clinerules"]);
    expect(result.rules[0].source).toBe("cline");
    expect(result.rules[0].always).toBe(true);
  });

  test("cline as a directory of md files", () => {
    const base = join(dir, ".clinerules");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "x.md"), "x body");

    const result = new RuleDiscovery(allFormats).discover(dir);

    expect(result.rules.map((r) => r.relPath)).toEqual([".clinerules/x.md"]);
  });

  test("copilot single instructions file plus instructions dir", () => {
    const gh = join(dir, ".github");
    mkdirSync(join(gh, "instructions"), { recursive: true });
    writeFileSync(join(gh, "copilot-instructions.md"), "main body");
    writeFileSync(join(gh, "instructions", "ts.instructions.md"), "---\napplyTo: ['src/**']\n---\nts body");

    const result = new RuleDiscovery(allFormats).discover(dir);
    const rels = result.rules.map((r) => r.relPath).sort();

    expect(rels).toEqual([".github/copilot-instructions.md", ".github/instructions/ts.instructions.md"]);
    const scoped = result.rules.find((r) => r.relPath.endsWith("ts.instructions.md"));
    expect(scoped?.scopes).toEqual(["src/**"]);
    expect(scoped?.always).toBe(false);
  });

  test("symlink to a real file is included", () => {
    const piDir = join(dir, ".pi", "rules");
    mkdirSync(piDir, { recursive: true });
    const target = join(dir, "target.md");
    writeFileSync(target, "linked body");
    symlinkSync(target, join(piDir, "link.md"));

    const result = new RuleDiscovery(allFormats).discover(dir);

    expect(result.rules.map((r) => r.relPath)).toEqual([".pi/rules/link.md"]);
  });

  test("full discovery order across formats", () => {
    const make = (rel: string[], content: string) => {
      const full = join(dir, ...rel);
      mkdirSync(join(dir, ...rel.slice(0, -1)), { recursive: true });
      writeFileSync(full, content);
    };

    make([".pi", "rules", "p.md"], "pi body");
    make([".claude", "rules", "c.md"], "claude body");
    make([".cursor", "rules", "u.mdc"], "cursor body");
    make([".windsurf", "rules", "w.md"], "windsurf body");
    writeFileSync(join(dir, ".clinerules"), "cline body");

    const result = new RuleDiscovery(allFormats).discover(dir);

    expect(result.rules.map((r) => r.source)).toEqual(["pi", "claude", "cursor", "windsurf", "cline"]);
  });
});
