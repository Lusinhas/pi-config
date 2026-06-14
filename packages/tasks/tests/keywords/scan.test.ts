import { describe, expect, test } from "bun:test";
import { Scanner } from "../../src/keywords/scan.ts";
import { LEVELS, isLevel, levelIndex, normalizeKeyword } from "../../src/keywords/scan.ts";

describe("levels", () => {
  test("ordering is exact", () => {
    expect(LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
  });

  test("isLevel accepts known strings and rejects others", () => {
    expect(isLevel("xhigh")).toBe(true);
    expect(isLevel("off")).toBe(true);
    expect(isLevel("HIGH")).toBe(false);
    expect(isLevel(3)).toBe(false);
    expect(isLevel(null)).toBe(false);
    expect(isLevel(undefined)).toBe(false);
  });

  test("levelIndex matches array order", () => {
    expect(levelIndex("off")).toBe(0);
    expect(levelIndex("medium")).toBe(3);
    expect(levelIndex("xhigh")).toBe(5);
  });
});

describe("normalizeKeyword", () => {
  test("trims, lowercases, collapses whitespace", () => {
    expect(normalizeKeyword("  Think   Harder ")).toBe("think harder");
    expect(normalizeKeyword("ULTRATHINK")).toBe("ultrathink");
  });
});

describe("wordRegex", () => {
  test("returns undefined for empty list", () => {
    expect(Scanner.wordRegex([])).toBeUndefined();
    expect(Scanner.wordRegex(["", "  "])).toBeUndefined();
  });

  test("matches whole words with unicode boundaries", () => {
    const regex = Scanner.wordRegex(["ultrathink"]);
    expect(regex).toBeDefined();
    expect(regex!.test("please ultrathink now")).toBe(true);
    regex!.lastIndex = 0;
    expect(regex!.test("ultrathinking")).toBe(false);
  });

  test("multi-word keywords join word parts with flexible whitespace", () => {
    const regex = Scanner.wordRegex(["think harder"]);
    expect(regex!.test("think   harder")).toBe(true);
    regex!.lastIndex = 0;
    expect(regex!.test("think\nharder")).toBe(true);
  });

  test("escapes regex metacharacters in keyword", () => {
    const regex = Scanner.wordRegex(["c++"]);
    expect(regex!.test("use c++ here")).toBe(true);
  });
});

describe("buildMatchers", () => {
  test("normalizes, dedups (first wins), drops invalid levels", () => {
    const matchers = Scanner.buildMatchers({
      "  Ultrathink ": "xhigh",
      ultrathink: "low",
      bad: "nope",
      quickthink: "low",
    });
    const keywords = matchers.map(m => m.keyword);
    expect(keywords).toContain("ultrathink");
    expect(keywords).toContain("quickthink");
    expect(keywords).not.toContain("bad");
    const ultra = matchers.find(m => m.keyword === "ultrathink");
    expect(ultra!.level).toBe("xhigh");
  });

  test("sorts descending by keyword length", () => {
    const matchers = Scanner.buildMatchers({
      ab: "low",
      abcd: "high",
      abc: "medium",
    });
    expect(matchers.map(m => m.keyword)).toEqual(["abcd", "abc", "ab"]);
  });

  test("empty keyword is skipped", () => {
    const matchers = Scanner.buildMatchers({ "   ": "high" });
    expect(matchers.length).toBe(0);
  });
});

describe("stripMatches", () => {
  test("removes a trailing space around the match", () => {
    const regex = Scanner.wordRegex(["foo"]);
    const result = Scanner.stripMatches("foo bar", regex!);
    expect(result.text).toBe("bar");
    expect(result.count).toBe(1);
  });

  test("removes a leading space when no trailing space", () => {
    const regex = Scanner.wordRegex(["bar"]);
    const result = Scanner.stripMatches("foo bar", regex!);
    expect(result.text).toBe("foo");
    expect(result.count).toBe(1);
  });

  test("removes multiple occurrences", () => {
    const regex = Scanner.wordRegex(["x"]);
    const result = Scanner.stripMatches("x and x and x", regex!);
    expect(result.count).toBe(3);
    expect(result.text).toBe("and and");
  });

  test("resets lastIndex so a shared regex instance is reusable", () => {
    const regex = Scanner.wordRegex(["go"]);
    const first = Scanner.stripMatches("go go", regex!);
    const second = Scanner.stripMatches("go now", regex!);
    expect(first.count).toBe(2);
    expect(second.count).toBe(1);
    expect(second.text).toBe("now");
  });

  test("zero matches returns text unchanged with count 0", () => {
    const regex = Scanner.wordRegex(["zzz"]);
    const result = Scanner.stripMatches("hello world", regex!);
    expect(result.text).toBe("hello world");
    expect(result.count).toBe(0);
  });
});

describe("scanThinking", () => {
  const matchers = Scanner.buildMatchers({
    ultrathink: "xhigh",
    "think harder": "high",
    quickthink: "low",
  });

  test("picks highest priority level among matches", () => {
    const scan = Scanner.scanThinking("please quickthink then ultrathink", matchers);
    expect(scan.level).toBe("xhigh");
    expect(scan.matched).toContain("ultrathink");
    expect(scan.matched).toContain("quickthink");
  });

  test("strips matched tokens from text", () => {
    const scan = Scanner.scanThinking("ultrathink about this", matchers);
    expect(scan.text).toBe("about this");
  });

  test("no match leaves text and undefined level", () => {
    const scan = Scanner.scanThinking("just a normal prompt", matchers);
    expect(scan.level).toBeUndefined();
    expect(scan.matched).toEqual([]);
    expect(scan.text).toBe("just a normal prompt");
  });

  test("longer multi-word keyword stripped first", () => {
    const scan = Scanner.scanThinking("can you think harder here", matchers);
    expect(scan.level).toBe("high");
    expect(scan.text).toBe("can you here");
  });

  test("cheap head pre-gate returns unchanged scan when no head token present", () => {
    const original = "render the dashboard and ship it";
    const scan = Scanner.scanThinking(original, matchers);
    expect(scan.level).toBeUndefined();
    expect(scan.matched).toEqual([]);
    expect(scan.text).toBe(original);
  });

  test("empty matcher set short-circuits to unchanged scan", () => {
    const scan = Scanner.scanThinking("ultrathink here", []);
    expect(scan.level).toBeUndefined();
    expect(scan.matched).toEqual([]);
    expect(scan.text).toBe("ultrathink here");
  });
});
