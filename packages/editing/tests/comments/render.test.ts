import { describe, expect, test } from "bun:test";
import { Config } from "../../src/comments/config.ts";
import type { CheckResult } from "../../src/comments/index.ts";
import type { Finding } from "../../src/comments/patterns.ts";
import { MODE_DESCRIPTIONS, Reporter } from "../../src/comments/render.ts";

const config = new Config(Config.hardDefaults()).defaultConfig();
const reporter = new Reporter();

function finding(over: Partial<Finding> = {}): Finding {
  return { rule: "narration", line: 3, text: "// loops over items", message: "narrating comment adds no information", ...over };
}

function result(over: Partial<CheckResult> = {}): CheckResult {
  return { path: "/repo/a.ts", tool: "write", findings: [finding()], ...over };
}

describe("formatFindings", () => {
  test("renders index, rule, line, clipped text and message", () => {
    expect(reporter.formatFindings([finding()], 10)).toBe(
      "1. [narration] line 3: // loops over items (narrating comment adds no information)",
    );
  });

  test("caps at max and appends hidden count", () => {
    const findings = [finding({ line: 1 }), finding({ line: 2 }), finding({ line: 3 })];
    const out = reporter.formatFindings(findings, 1);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("… 2 more findings not shown");
  });

  test("single hidden uses singular", () => {
    const findings = [finding({ line: 1 }), finding({ line: 2 })];
    expect(reporter.formatFindings(findings, 1)).toContain("… 1 more finding not shown");
  });

  test("max is clamped to at least 1", () => {
    const findings = [finding({ line: 1 }), finding({ line: 2 })];
    expect(reporter.formatFindings(findings, 0).split("\n")[0]).toContain("line 1");
  });
});

describe("clip boundary via formatFindings", () => {
  test("exactly 160 chars kept whole", () => {
    const text = "x".repeat(160);
    const out = reporter.formatFindings([finding({ text })], 10);
    expect(out).toContain(text);
    expect(out).not.toContain("…");
  });

  test("161 chars truncated to 159 plus ellipsis", () => {
    const text = "x".repeat(161);
    const out = reporter.formatFindings([finding({ text })], 10);
    expect(out).toContain(`${"x".repeat(159)}…`);
  });

  test("whitespace collapsed", () => {
    const out = reporter.formatFindings([finding({ text: "//   a    b\t c" })], 10);
    expect(out).toContain("// a b c");
  });
});

describe("blockReason / warnNotice", () => {
  test("block reason three lines, plural", () => {
    const out = reporter.blockReason(result({ findings: [finding({ line: 1 }), finding({ line: 2 })] }), config);
    const lines = out.split("\n");
    expect(lines[0]).toBe(
      "comments: blocked write to /repo/a.ts — 2 low-value comment findings (line numbers refer to the new content):",
    );
    expect(lines[lines.length - 1]).toContain("@allow-comment");
  });

  test("block reason singular when one finding", () => {
    const out = reporter.blockReason(result(), config);
    expect(out.split("\n")[0]).toContain("1 low-value comment finding (");
  });

  test("warn notice header", () => {
    const out = reporter.warnNotice(result(), config);
    expect(out.split("\n")[0]).toBe(
      "comments: found 1 low-value comment finding in /repo/a.ts (warn mode, change was applied; line numbers refer to the new content):",
    );
  });
});

describe("warnKey", () => {
  test("encodes path and rule:text pairs", () => {
    const r = result({ findings: [finding({ rule: "todo", text: "// TODO" }), finding({ rule: "separator", text: "// ==" })] });
    expect(reporter.warnKey(r)).toBe("/repo/a.ts|todo:// TODO|separator:// ==");
  });
});

describe("buildReport", () => {
  test("lists mode, detectors, marker, glob count, max, and no-history line", () => {
    const out = reporter.buildReport({ mode: "block", history: [] }, config);
    const lines = out.split("\n");
    expect(lines[0]).toBe(`mode: block (${MODE_DESCRIPTIONS.block})`);
    expect(lines[1]).toBe("detectors: narration, fillerdoc, changemarker, todo, separator");
    expect(lines[2]).toBe("allow marker: @allow-comment");
    expect(lines[3]).toBe(`ignore globs: ${config.ignore.length}`);
    expect(lines[4]).toBe("max findings reported: 10");
    expect(lines[5]).toBe("last findings: (none this session)");
  });

  test("detectors none when all disabled", () => {
    const noneConfig = {
      ...config,
      detectors: { narration: false, fillerdoc: false, changemarker: false, todo: false, separator: false },
    };
    expect(reporter.buildReport({ mode: "off", history: [] }, noneConfig)).toContain("detectors: (none)");
  });

  test("history summary uses history[0]", () => {
    const out = reporter.buildReport({ mode: "warn", history: [result()] }, config);
    expect(out).toContain("last findings: 1 in /repo/a.ts via write; run /comments last for details");
  });
});

describe("buildHistory", () => {
  test("empty history message", () => {
    expect(reporter.buildHistory({ mode: "block", history: [] }, config)).toBe(
      "comments: no findings recorded this session.",
    );
  });

  test("sections joined by blank line", () => {
    const out = reporter.buildHistory({ mode: "block", history: [result(), result({ tool: "edit" })] }, config);
    expect(out).toContain("\n\n");
    expect(out).toContain("1) /repo/a.ts (write, 1 finding):");
    expect(out).toContain("2) /repo/a.ts (edit, 1 finding):");
  });
});

describe("MODE_DESCRIPTIONS", () => {
  test("verbatim strings", () => {
    expect(MODE_DESCRIPTIONS).toEqual({
      block: "slop comments block the write/edit until rewritten",
      warn: "slop comments pass but trigger a follow-up notice",
      off: "comment policing disabled",
    });
  });
});
