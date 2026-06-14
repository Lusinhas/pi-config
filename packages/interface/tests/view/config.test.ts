import { describe, expect, test } from "bun:test";
import { Config, DEFAULTS } from "../../src/view/config.ts";

describe("Config.isRecord", () => {
  test("accepts plain objects only", () => {
    expect(Config.isRecord({})).toBe(true);
    expect(Config.isRecord({ a: 1 })).toBe(true);
  });

  test("rejects null, arrays, and primitives", () => {
    expect(Config.isRecord(null)).toBe(false);
    expect(Config.isRecord([])).toBe(false);
    expect(Config.isRecord("x")).toBe(false);
    expect(Config.isRecord(5)).toBe(false);
  });
});

describe("Config.positiveInt", () => {
  test("floors a positive finite number", () => {
    expect(Config.positiveInt(12.9, 99)).toBe(12);
  });

  test("falls back for zero, negatives, non-finite, and non-numbers", () => {
    expect(Config.positiveInt(0, 99)).toBe(99);
    expect(Config.positiveInt(-3, 99)).toBe(99);
    expect(Config.positiveInt(Number.NaN, 99)).toBe(99);
    expect(Config.positiveInt(Number.POSITIVE_INFINITY, 99)).toBe(99);
    expect(Config.positiveInt("8", 99)).toBe(99);
    expect(Config.positiveInt(undefined, 99)).toBe(99);
  });
});

describe("Config.section", () => {
  test("returns the toolview section when it is a record", () => {
    expect(Config.section({ toolview: { maxLines: 4 } })).toEqual({ maxLines: 4 });
  });

  test("returns null when missing or not a record", () => {
    expect(Config.section(null)).toBeNull();
    expect(Config.section({})).toBeNull();
    expect(Config.section({ toolview: 5 })).toBeNull();
    expect(Config.section({ toolview: [] })).toBeNull();
  });
});

describe("Config.fromLayers", () => {
  test("returns shipped defaults when no overrides", () => {
    const config = Config.fromLayers({ ...DEFAULTS }, []);

    expect(config).toEqual(DEFAULTS);
  });

  test("returns full defaults when shipped is missing", () => {
    expect(Config.fromLayers(null, [])).toEqual(DEFAULTS);
    expect(Config.fromLayers(undefined, [])).toEqual(DEFAULTS);
  });

  test("project section wins over global section", () => {
    const shipped = { ...DEFAULTS };
    const global = { maxLines: 5, compactChars: 50 };
    const project = { maxLines: 7 };
    const config = Config.fromLayers(shipped, [global, project]);

    expect(config.maxLines).toBe(7);
    expect(config.compactChars).toBe(50);
    expect(config.maxLineChars).toBe(DEFAULTS.maxLineChars);
    expect(config.viewportLines).toBe(DEFAULTS.viewportLines);
  });

  test("invalid override values fall back per key", () => {
    const config = Config.fromLayers({ ...DEFAULTS }, [{ maxLines: -1, maxLineChars: "big", viewportLines: 0 }]);

    expect(config.maxLines).toBe(DEFAULTS.maxLines);
    expect(config.maxLineChars).toBe(DEFAULTS.maxLineChars);
    expect(config.viewportLines).toBe(DEFAULTS.viewportLines);
  });

  test("ignores non-record layers", () => {
    const config = Config.fromLayers({ ...DEFAULTS }, [null, undefined, [] as unknown as Record<string, unknown>]);

    expect(config).toEqual(DEFAULTS);
  });

  test("floors fractional override values", () => {
    const config = Config.fromLayers({ ...DEFAULTS }, [{ maxLines: 9.8 }]);

    expect(config.maxLines).toBe(9);
  });
});
