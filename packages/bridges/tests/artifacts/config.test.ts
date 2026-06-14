import { describe, expect, test } from "bun:test";
import { Config, DEFAULTS } from "../../src/artifacts/render.ts";

describe("Config.fromLayers", () => {
  test("returns defaults with no layers", () => {
    expect(Config.fromLayers([])).toEqual(DEFAULTS);
  });

  test("project layer wins over global over shipped", () => {
    const result = Config.fromLayers([
      { spillBytes: 4096 },
      { spillBytes: 8192 },
      { spillBytes: 16384 },
    ]);
    expect(result.spillBytes).toBe(16384);
  });

  test("ignores null and non-record layers", () => {
    expect(Config.fromLayers([null, undefined, { headLines: 5 }])).toMatchObject({ headLines: 5 });
  });
});

describe("intAtLeast validators", () => {
  test("spillBytes below minimum falls back", () => {
    expect(Config.fromMerged({ spillBytes: 100 }).spillBytes).toBe(DEFAULTS.spillBytes);
  });

  test("spillBytes at minimum accepted and floored", () => {
    expect(Config.fromMerged({ spillBytes: 1024.9 }).spillBytes).toBe(1024);
  });

  test("non-finite spillBytes falls back", () => {
    expect(Config.fromMerged({ spillBytes: Number.NaN }).spillBytes).toBe(DEFAULTS.spillBytes);
    expect(Config.fromMerged({ spillBytes: Number.POSITIVE_INFINITY }).spillBytes).toBe(DEFAULTS.spillBytes);
  });

  test("non-number spillBytes falls back", () => {
    expect(Config.fromMerged({ spillBytes: "30000" }).spillBytes).toBe(DEFAULTS.spillBytes);
  });

  test("headLines accepts zero", () => {
    expect(Config.fromMerged({ headLines: 0 }).headLines).toBe(0);
  });

  test("headLines negative falls back", () => {
    expect(Config.fromMerged({ headLines: -1 }).headLines).toBe(DEFAULTS.headLines);
  });

  test("tailLines accepts zero and floors", () => {
    expect(Config.fromMerged({ tailLines: 0 }).tailLines).toBe(0);
    expect(Config.fromMerged({ tailLines: 9.9 }).tailLines).toBe(9);
  });

  test("retrieveLines minimum is 1", () => {
    expect(Config.fromMerged({ retrieveLines: 0 }).retrieveLines).toBe(DEFAULTS.retrieveLines);
    expect(Config.fromMerged({ retrieveLines: 1 }).retrieveLines).toBe(1);
  });
});

describe("positiveNumber maxAgeDays", () => {
  test("accepts fractional positive without flooring", () => {
    expect(Config.fromMerged({ maxAgeDays: 0.5 }).maxAgeDays).toBe(0.5);
  });

  test("zero or negative falls back", () => {
    expect(Config.fromMerged({ maxAgeDays: 0 }).maxAgeDays).toBe(DEFAULTS.maxAgeDays);
    expect(Config.fromMerged({ maxAgeDays: -3 }).maxAgeDays).toBe(DEFAULTS.maxAgeDays);
  });

  test("non-finite falls back", () => {
    expect(Config.fromMerged({ maxAgeDays: Number.NaN }).maxAgeDays).toBe(DEFAULTS.maxAgeDays);
  });
});

describe("skipTools", () => {
  test("always seeds artifact", () => {
    expect(Config.fromMerged({}).skipTools).toEqual(["artifact"]);
  });

  test("adds trimmed string entries and dedupes", () => {
    expect(Config.fromMerged({ skipTools: ["  bash  ", "bash", "grep"] }).skipTools).toEqual([
      "artifact",
      "bash",
      "grep",
    ]);
  });

  test("ignores non-string and empty entries", () => {
    expect(Config.fromMerged({ skipTools: ["", "   ", 5, null, "ok"] }).skipTools).toEqual(["artifact", "ok"]);
  });

  test("non-array skipTools yields only artifact", () => {
    expect(Config.fromMerged({ skipTools: "bash" }).skipTools).toEqual(["artifact"]);
  });
});

describe("deepMerge", () => {
  test("recurses into nested records and overrides scalars", () => {
    const merged = Config.deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 9, z: 3 } });
    expect(merged).toEqual({ a: { x: 1, y: 9, z: 3 } });
  });

  test("array override replaces wholesale", () => {
    const merged = Config.deepMerge({ a: [1, 2] }, { a: [3] });
    expect(merged).toEqual({ a: [3] });
  });
});

describe("isRecord", () => {
  test("rejects arrays and null", () => {
    expect(Config.isRecord([])).toBe(false);
    expect(Config.isRecord(null)).toBe(false);
    expect(Config.isRecord({})).toBe(true);
  });
});
