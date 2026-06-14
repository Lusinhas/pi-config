import { describe, expect, test } from "bun:test";
import {
  Config,
  DEFAULTS,
  LARGE_FILE_BYTES,
  deepMerge,
  isRecord,
  nonNegativeInt,
  positiveInt,
} from "../../src/lines/config.ts";

describe("constants", () => {
  test("LARGE_FILE_BYTES is 64MB", () => {
    expect(LARGE_FILE_BYTES).toBe(64 * 1024 * 1024);
  });

  test("defaults match the shipped contract", () => {
    expect(DEFAULTS).toEqual({
      compat: true,
      defaultMode: "hashline",
      modes: {},
      maxLines: 2000,
      maxBytes: 51200,
      maxLineLength: 2000,
      contextLines: 2,
    });
  });
});

describe("isRecord", () => {
  test("true for plain objects", () => {
    expect(isRecord({})).toBe(true);
  });

  test("false for arrays and null and primitives", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(3)).toBe(false);
  });
});

describe("deepMerge", () => {
  test("recursively merges nested records", () => {
    expect(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 9 } })).toEqual({ a: { x: 1, y: 9 } });
  });

  test("override replaces non-record values", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  test("array override replaces rather than merging", () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });
});

describe("positiveInt", () => {
  test("floors valid positive numbers", () => {
    expect(positiveInt(3.9, 1)).toBe(3);
  });

  test("rejects zero, negatives, non-finite, non-number", () => {
    expect(positiveInt(0, 7)).toBe(7);
    expect(positiveInt(-5, 7)).toBe(7);
    expect(positiveInt(Number.NaN, 7)).toBe(7);
    expect(positiveInt("4", 7)).toBe(7);
  });
});

describe("nonNegativeInt", () => {
  test("accepts zero", () => {
    expect(nonNegativeInt(0, 2)).toBe(0);
  });

  test("rejects negatives and non-number", () => {
    expect(nonNegativeInt(-1, 2)).toBe(2);
    expect(nonNegativeInt(null, 2)).toBe(2);
  });
});

describe("Config.section", () => {
  test("extracts hashline section when present", () => {
    expect(Config.section({ hashline: { compat: false } })).toEqual({ compat: false });
  });

  test("null when missing or non-record", () => {
    expect(Config.section({ other: 1 })).toBeNull();
    expect(Config.section({ hashline: 5 })).toBeNull();
    expect(Config.section(null)).toBeNull();
  });
});

describe("Config.load", () => {
  test("all null sources produce defaults", () => {
    expect(Config.load(null, null, null)).toEqual(DEFAULTS);
  });

  test("project section wins over global and shipped", () => {
    const result = Config.load({ maxLines: 10 }, { maxLines: 20 }, { maxLines: 30 });
    expect(result.maxLines).toBe(30);
  });

  test("invalid types fall back to default per key", () => {
    const result = Config.load(
      { compat: "yes", defaultMode: "weird", maxLines: -1, maxBytes: 0, maxLineLength: Number.NaN, contextLines: -3 },
      null,
      null,
    );
    expect(result.compat).toBe(true);
    expect(result.defaultMode).toBe("hashline");
    expect(result.maxLines).toBe(2000);
    expect(result.maxBytes).toBe(51200);
    expect(result.maxLineLength).toBe(2000);
    expect(result.contextLines).toBe(2);
  });

  test("modes keep only valid entries with non-empty patterns", () => {
    const result = Config.load(
      { modes: { "gpt-*": "compat", "": "hashline", bad: "auto", sonnet: "hashline" } },
      null,
      null,
    );
    expect(result.modes).toEqual({ "gpt-*": "compat", sonnet: "hashline" });
  });

  test("modes non-record falls back to empty", () => {
    const result = Config.load({ modes: [1, 2] }, null, null);
    expect(result.modes).toEqual({});
  });

  test("valid overrides flow through", () => {
    const result = Config.load(null, { compat: false, contextLines: 0 }, { defaultMode: "compat" });
    expect(result.compat).toBe(false);
    expect(result.contextLines).toBe(0);
    expect(result.defaultMode).toBe("compat");
  });
});
