import { describe, expect, test } from "bun:test";
import { Config } from "../../src/plan/settings.ts";

describe("Config.isRecord", () => {
  test("accepts plain objects", () => {
    expect(Config.isRecord({})).toBe(true);
    expect(Config.isRecord({ a: 1 })).toBe(true);
  });

  test("rejects arrays, null, and primitives", () => {
    expect(Config.isRecord([])).toBe(false);
    expect(Config.isRecord(null)).toBe(false);
    expect(Config.isRecord(7)).toBe(false);
    expect(Config.isRecord("x")).toBe(false);
  });
});

describe("Config.deepMerge", () => {
  test("descends into nested records", () => {
    const out = Config.deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 9, z: 3 } });

    expect(out).toEqual({ a: { x: 1, y: 9, z: 3 } });
  });

  test("does not descend into arrays", () => {
    const out = Config.deepMerge({ a: [1, 2] }, { a: [3] });

    expect(out).toEqual({ a: [3] });
  });

  test("skips undefined override values", () => {
    const out = Config.deepMerge({ a: 1 }, { a: undefined });

    expect(out).toEqual({ a: 1 });
  });
});

describe("Config.stringList", () => {
  test("copies the fallback when value is not an array", () => {
    const fallback = ["a", "b"];
    const out = Config.stringList("nope", fallback);

    expect(out).toEqual(["a", "b"]);
    expect(out).not.toBe(fallback);
  });

  test("filters non-strings, trims, drops empty, dedups, preserves order", () => {
    const out = Config.stringList(["  read ", 5, "read", "", "  ", "grep", null, "grep"], ["fallback"]);

    expect(out).toEqual(["read", "grep"]);
  });
});

describe("Config.text", () => {
  test("keeps non-empty strings untrimmed", () => {
    expect(Config.text("  spaced  ", "fb")).toBe("  spaced  ");
  });

  test("falls back on empty string and non-strings", () => {
    expect(Config.text("", "fb")).toBe("fb");
    expect(Config.text(42, "fb")).toBe("fb");
    expect(Config.text(undefined, "fb")).toBe("fb");
  });
});

describe("Config.flag", () => {
  test("accepts booleans and falls back otherwise", () => {
    expect(Config.flag(true, false)).toBe(true);
    expect(Config.flag(false, true)).toBe(false);
    expect(Config.flag("true", true)).toBe(true);
    expect(Config.flag(1, false)).toBe(false);
  });
});

describe("Config.count", () => {
  test("accepts finite non-negative numbers", () => {
    expect(Config.count(0, 5)).toBe(0);
    expect(Config.count(120000, 5)).toBe(120000);
  });

  test("falls back on negative, NaN, Infinity, and wrong types", () => {
    expect(Config.count(-1, 5)).toBe(5);
    expect(Config.count(Number.NaN, 5)).toBe(5);
    expect(Config.count(Number.POSITIVE_INFINITY, 5)).toBe(5);
    expect(Config.count("9", 5)).toBe(5);
  });
});

describe("Config.fromRaw defaults", () => {
  test("uses defaults when everything is null", () => {
    expect(Config.fromRaw(null, null, null)).toEqual(Config.DEFAULTS);
  });

  test("preserves every default value", () => {
    const out = Config.fromRaw(null, null, null);

    expect(out.readonlyTools).toEqual(["read", "grep", "find", "ls"]);
    expect(out.extraAllowed).toEqual(["websearch", "webfetch", "astsearch", "history", "task", "advisor"]);
    expect(out.blockedTools).toEqual(["write", "edit", "bash"]);
    expect(out.statusText).toBe("plan");
    expect(out.showWidget).toBe(true);
    expect(out.review).toEqual({ enabled: true, timeoutMs: 120000, minLength: 80, keywords: ["plan"] });
  });
});

describe("Config.fromRaw merge order", () => {
  test("shipped overrides defaults", () => {
    const out = Config.fromRaw({ statusText: "planning" }, null, null);

    expect(out.statusText).toBe("planning");
  });

  test("global plan section overrides shipped", () => {
    const out = Config.fromRaw({ statusText: "planning" }, { plan: { statusText: "g" } }, null);

    expect(out.statusText).toBe("g");
  });

  test("project plan section wins over global", () => {
    const out = Config.fromRaw(
      { statusText: "planning" },
      { plan: { statusText: "g" } },
      { plan: { statusText: "p" } },
    );

    expect(out.statusText).toBe("p");
  });

  test("ignores non-record plan sections", () => {
    const out = Config.fromRaw(null, { plan: "nope" }, { plan: [1, 2] });

    expect(out).toEqual(Config.DEFAULTS);
  });

  test("merges nested review section deeply", () => {
    const out = Config.fromRaw(null, { plan: { review: { minLength: 10 } } }, null);

    expect(out.review.minLength).toBe(10);
    expect(out.review.enabled).toBe(true);
    expect(out.review.timeoutMs).toBe(120000);
  });
});

describe("Config per-key normalization", () => {
  test("invalid review values fall back to defaults", () => {
    const out = Config.fromRaw(
      null,
      null,
      { plan: { review: { enabled: "yes", timeoutMs: -10, minLength: Number.NaN, keywords: "plan" } } },
    );

    expect(out.review).toEqual(Config.DEFAULTS.review);
  });

  test("readonlyTools dedup and trim are applied through the merge", () => {
    const out = Config.fromRaw(null, null, { plan: { readonlyTools: ["  read ", "read", "", "ls"] } });

    expect(out.readonlyTools).toEqual(["read", "ls"]);
  });

  test("empty-string text values fall back", () => {
    const out = Config.fromRaw(null, null, { plan: { blockReason: "", systemPrompt: "  custom  " } });

    expect(out.blockReason).toBe(Config.DEFAULTS.blockReason);
    expect(out.systemPrompt).toBe("  custom  ");
  });
});
