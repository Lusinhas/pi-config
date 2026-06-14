import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RulesSettings } from "../../src/rules/settings.ts";
import { PATH_KEYS, PATH_LIST_KEYS, RulesEngine, SEARCH_LOCATIONS } from "../../src/rules/index.ts";
import { BudgetFiller } from "../../src/rules/matcher.ts";
import { RuleDiscovery } from "../../src/rules/formats.ts";
import { GlobMatcher } from "../../src/rules/matcher.ts";

const baseSettings: RulesSettings = {
  formats: { pi: true, claude: true, cursor: true, copilot: true, windsurf: true, cline: true },
  alwaysBudget: 8000,
  scopedBudget: 6000,
};

function engineFor(dir: string, settings: RulesSettings = baseSettings): RulesEngine {
  return new RulesEngine(settings, new RuleDiscovery(settings.formats), new GlobMatcher());
}

describe("RulesEngine constants", () => {
  test("PATH_KEYS preserved exactly and in order", () => {
    expect([...PATH_KEYS]).toEqual([
      "path",
      "file_path",
      "filePath",
      "absolute_path",
      "absolutePath",
      "file",
      "filename",
      "directory",
      "dir",
    ]);
  });

  test("PATH_LIST_KEYS preserved exactly", () => {
    expect([...PATH_LIST_KEYS]).toEqual(["paths", "files"]);
  });

  test("SEARCH_LOCATIONS string is verbatim", () => {
    expect(SEARCH_LOCATIONS).toBe(
      ".pi/rules/*.md, .claude/rules/*.md, .cursor/rules/*.mdc, .github/copilot-instructions.md, .github/instructions/*.instructions.md, .windsurf/rules/*.md, .clinerules",
    );
  });
});

describe("BudgetFiller", () => {
  test("renderHeader marks always and scoped rules distinctly", () => {
    const filler = new BudgetFiller();

    expect(
      filler.renderHeader({
        source: "pi",
        path: "/p/.pi/rules/a.md",
        relPath: ".pi/rules/a.md",
        scopes: [],
        always: true,
        body: "B",
      }),
    ).toBe("### Rule: .pi/rules/a.md [pi, always]");

    expect(
      filler.renderHeader({
        source: "pi",
        path: "/p/.pi/rules/b.md",
        relPath: ".pi/rules/b.md",
        scopes: ["src/*.ts"],
        always: false,
        body: "B",
      }),
    ).toBe("### Rule: .pi/rules/b.md [pi, paths: src/*.ts]");
  });
});

describe("RulesEngine injection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rules-engine-"));
    mkdirSync(join(dir, ".pi", "rules"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRule(name: string, content: string): void {
    writeFileSync(join(dir, ".pi", "rules", name), content);
  }

  test("untrusted refresh loads nothing", () => {
    writeRule("a.md", "always body");
    const engine = engineFor(dir);
    engine.refresh(dir, false);
    engine.resetTurns();

    expect(engine.isTrusted()).toBe(false);
    expect(engine.buildInjection([])).toBeUndefined();
    expect(engine.hasRulesOrErrors()).toBe(false);
  });

  test("always rule is injected with exact header and preamble", () => {
    writeRule("always.md", "---\nalwaysApply: true\n---\nALWAYS RULE BODY");
    const engine = engineFor(dir);
    engine.refresh(dir, true);
    engine.resetTurns();

    const injection = engine.buildInjection([]);

    expect(injection).toBeDefined();
    expect(injection?.customType).toBe("rulesinjection");
    expect(injection?.display).toBe(false);
    expect(injection?.content).toBe(
      "Project rules in effect. Each block names its source file; scoped rules apply when working on their listed paths.\n\n### Rule: .pi/rules/always.md [pi, always]\nALWAYS RULE BODY",
    );
  });

  test("scoped rule only injected when a touched path matches", () => {
    writeRule("scoped.md", "---\nglobs: src/*.ts\n---\nSCOPED BODY");
    const engine = engineFor(dir);
    engine.refresh(dir, true);
    engine.resetTurns();

    expect(engine.buildInjection(["docs/x.md"])).toBeUndefined();

    engine.resetTurns();
    const hit = engine.buildInjection(["src/a.ts"]);

    expect(hit?.content).toContain("### Rule: .pi/rules/scoped.md [pi, paths: src/*.ts]");
    expect(hit?.content).toContain("SCOPED BODY");
  });

  test("always blocks precede scoped blocks", () => {
    writeRule("a-always.md", "---\nalwaysApply: true\n---\nALWAYS");
    writeRule("b-scoped.md", "---\nglobs: src/*.ts\n---\nSCOPED");
    const engine = engineFor(dir);
    engine.refresh(dir, true);
    engine.resetTurns();

    const content = engine.buildInjection(["src/a.ts"])?.content ?? "";
    const alwaysIdx = content.indexOf("ALWAYS");
    const scopedIdx = content.indexOf("SCOPED");

    expect(alwaysIdx).toBeGreaterThanOrEqual(0);
    expect(scopedIdx).toBeGreaterThan(alwaysIdx);
  });

  test("dedup by hash skips re-emitting an unchanged rule but keeps it active", () => {
    writeRule("a.md", "---\nalwaysApply: true\n---\nSTABLE BODY");
    const engine = engineFor(dir);
    engine.refresh(dir, true);
    engine.resetTurns();

    const first = engine.buildInjection([]);
    expect(first?.content).toContain("STABLE BODY");

    const second = engine.buildInjection([]);
    expect(second).toBeUndefined();

    const report = engine.report();
    expect(report.some((line) => line.includes("[active]"))).toBe(true);
  });

  test("changed body re-injects after refresh", () => {
    writeRule("a.md", "---\nalwaysApply: true\n---\nVERSION ONE");
    const engine = engineFor(dir);
    engine.refresh(dir, true);
    engine.resetTurns();

    expect(engine.buildInjection([])?.content).toContain("VERSION ONE");
    expect(engine.buildInjection([])).toBeUndefined();

    writeRule("a.md", "---\nalwaysApply: true\n---\nVERSION TWO");
    engine.refresh(dir, true);

    expect(engine.buildInjection([])?.content).toContain("VERSION TWO");
  });

  test("first block of an empty group is truncated under tight budget", () => {
    const body = "X".repeat(500);
    writeRule("a.md", `---\nalwaysApply: true\n---\n${body}`);
    const engine = engineFor(dir, { ...baseSettings, alwaysBudget: 200 });
    engine.refresh(dir, true);
    engine.resetTurns();

    const content = engine.buildInjection([])?.content ?? "";

    expect(content).toContain("[rule truncated to fit budget]");
    expect(content).not.toContain("X".repeat(500));
  });

  test("rule skipped entirely when remaining budget is below overhead", () => {
    const body = "X".repeat(500);
    writeRule("a.md", `---\nalwaysApply: true\n---\n${body}`);
    const engine = engineFor(dir, { ...baseSettings, alwaysBudget: 5 });
    engine.refresh(dir, true);
    engine.resetTurns();

    expect(engine.buildInjection([])).toBeUndefined();
  });

  test("second block does not truncate once group is non-empty", () => {
    writeRule("a.md", "---\nalwaysApply: true\n---\nSMALL");
    writeRule("b.md", `---\nalwaysApply: true\n---\n${"Y".repeat(9000)}`);
    const engine = engineFor(dir, { ...baseSettings, alwaysBudget: 120 });
    engine.refresh(dir, true);
    engine.resetTurns();

    const content = engine.buildInjection([])?.content ?? "";

    expect(content).toContain("SMALL");
    expect(content).not.toContain("[rule truncated to fit budget]");
    expect(content).not.toContain("Y".repeat(200));
  });
});

describe("RulesEngine report", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rules-report-"));
    mkdirSync(join(dir, ".pi", "rules"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRule(name: string, content: string): void {
    writeFileSync(join(dir, ".pi", "rules", name), content);
  }

  test("pending status before any turn and singular error suffix", () => {
    writeRule("a.md", "---\nalwaysApply: true\n---\nBODY");
    writeRule("broken.md", "---\nfoo: bar");
    const engine = engineFor(dir);
    engine.refresh(dir, true);
    engine.resetTurns();

    const lines = engine.report();

    expect(lines[0]).toBe("Rules: 1 discovered, no turns yet, 1 parse error");
    expect(lines).toContain("  [pending] pi .pi/rules/a.md - always");
    expect(lines).toContain("Parse errors:");
    expect(lines).toContain("  pi .pi/rules/broken.md: unterminated frontmatter");
  });

  test("plural error suffix and active/inactive after a turn", () => {
    writeRule("always.md", "---\nalwaysApply: true\n---\nA");
    writeRule("scoped.md", "---\nglobs: src/*.ts\n---\nS");
    writeRule("broken1.md", "---\nx: 1");
    writeRule("broken2.md", "---\ny: 2");
    const engine = engineFor(dir);
    engine.refresh(dir, true);
    engine.resetTurns();
    engine.buildInjection(["src/a.ts"]);

    const lines = engine.report();

    expect(lines[0]).toBe("Rules: 2 discovered, 2 active last turn, 2 parse errors");
    expect(lines).toContain("  [active] pi .pi/rules/always.md - always");
    expect(lines).toContain("  [active] pi .pi/rules/scoped.md - src/*.ts");
  });

  test("manual scope label when scoped rule has no scopes", () => {
    writeRule("c.mdc", "---\nalwaysApply: false\n---\nbody");
    mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "rules", "c.mdc"), "---\nalwaysApply: false\n---\nbody");
    const engine = engineFor(dir);
    engine.refresh(dir, true);
    engine.resetTurns();

    const lines = engine.report();

    expect(lines.some((line) => line.includes("manual (no scope)"))).toBe(true);
  });

  test("disabled formats listed in key order", () => {
    writeRule("a.md", "---\nalwaysApply: true\n---\nBODY");
    const engine = engineFor(dir, {
      ...baseSettings,
      formats: { ...baseSettings.formats, claude: false, windsurf: false },
    });
    engine.refresh(dir, true);
    engine.resetTurns();

    const lines = engine.report();

    expect(lines).toContain("Disabled formats: claude, windsurf");
  });
});
