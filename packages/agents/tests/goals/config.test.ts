import { describe, expect, it } from "bun:test";
import { Config } from "../../src/goals/config.ts";

describe("Config defaults", () => {
  it("matches the shipped byte-identical defaults with no layers", () => {
    const config = new Config([]);

    expect(config.values).toEqual({
      judgeModel: "anthropic/claude-haiku-4-5",
      judgeTimeoutMs: 30000,
      judgeMaxChars: 8000,
      metMarker: "<goal-met/>",
      maxIterations: 25,
      enforceTodos: false,
      loopMinIntervalMs: 5000,
      statusMaxChars: 48,
    });
  });

  it("ignores non-record layers", () => {
    const config = new Config([undefined, null, 7, "x", [], false]);

    expect(config.values).toEqual(Config.defaults);
  });
});

describe("Config isRecord", () => {
  it("rejects arrays, null, and primitives", () => {
    expect(Config.isRecord({})).toBe(true);
    expect(Config.isRecord([])).toBe(false);
    expect(Config.isRecord(null)).toBe(false);
    expect(Config.isRecord("x")).toBe(false);
    expect(Config.isRecord(3)).toBe(false);
  });
});

describe("Config positive", () => {
  it("accepts finite positive numbers and falls back otherwise", () => {
    expect(Config.positive(12, 99)).toBe(12);
    expect(Config.positive(0, 99)).toBe(99);
    expect(Config.positive(-1, 99)).toBe(99);
    expect(Config.positive(Number.NaN, 99)).toBe(99);
    expect(Config.positive(Number.POSITIVE_INFINITY, 99)).toBe(99);
    expect(Config.positive("5", 99)).toBe(99);
  });
});

describe("Config deepMerge", () => {
  it("merges nested records recursively", () => {
    const base = { a: { x: 1, y: 2 }, b: 3 };
    const merged = Config.deepMerge(base, { a: { y: 9, z: 4 }, c: 5 });

    expect(merged).toEqual({ a: { x: 1, y: 9, z: 4 }, b: 3, c: 5 });
  });

  it("skips override values that are undefined", () => {
    const merged = Config.deepMerge({ a: 1, b: 2 }, { a: undefined, b: 7 });

    expect(merged).toEqual({ a: 1, b: 7 });
  });

  it("replaces a record with a scalar when override is scalar", () => {
    const merged = Config.deepMerge({ a: { x: 1 } }, { a: 5 });

    expect(merged).toEqual({ a: 5 });
  });

  it("does not mutate the base object", () => {
    const base = { a: { x: 1 } };
    Config.deepMerge(base, { a: { x: 2 } });

    expect(base).toEqual({ a: { x: 1 } });
  });
});

describe("Config section", () => {
  it("extracts the goals section from a suite.json layer", () => {
    expect(Config.section({ goals: { maxIterations: 3 } })).toEqual({ maxIterations: 3 });
  });

  it("returns undefined when the goals section is missing or not a record", () => {
    expect(Config.section({ subagents: {} })).toBeUndefined();
    expect(Config.section({ goals: 5 })).toBeUndefined();
    expect(Config.section(null)).toBeUndefined();
    expect(Config.section([])).toBeUndefined();
  });
});

describe("Config coercion", () => {
  it("trims a valid judgeModel and falls back on empty/blank", () => {
    expect(new Config([{ goals: undefined }, { judgeModel: "  x/y  " }]).values.judgeModel).toBe("x/y");
    expect(new Config([{ judgeModel: "   " }]).values.judgeModel).toBe("anthropic/claude-haiku-4-5");
    expect(new Config([{ judgeModel: 5 }]).values.judgeModel).toBe("anthropic/claude-haiku-4-5");
  });

  it("floors positive numeric keys and falls back on invalid", () => {
    const config = new Config([
      { judgeMaxChars: 1234.9, maxIterations: 3.7, statusMaxChars: 10.2, judgeTimeoutMs: 1500, loopMinIntervalMs: 250 },
    ]);

    expect(config.values.judgeMaxChars).toBe(1234);
    expect(config.values.maxIterations).toBe(3);
    expect(config.values.statusMaxChars).toBe(10);
    expect(config.values.judgeTimeoutMs).toBe(1500);
    expect(config.values.loopMinIntervalMs).toBe(250);

    const bad = new Config([{ judgeMaxChars: -1, maxIterations: 0, judgeTimeoutMs: "x" }]);

    expect(bad.values.judgeMaxChars).toBe(8000);
    expect(bad.values.maxIterations).toBe(25);
    expect(bad.values.judgeTimeoutMs).toBe(30000);
  });

  it("accepts an empty metMarker only as the literal default fallback", () => {
    expect(new Config([{ metMarker: "" }]).values.metMarker).toBe("<goal-met/>");
    expect(new Config([{ metMarker: "<x/>" }]).values.metMarker).toBe("<x/>");
  });

  it("requires enforceTodos to be a real boolean", () => {
    expect(new Config([{ enforceTodos: true }]).values.enforceTodos).toBe(true);
    expect(new Config([{ enforceTodos: "true" }]).values.enforceTodos).toBe(false);
    expect(new Config([{ enforceTodos: 1 }]).values.enforceTodos).toBe(false);
  });

  it("lets a later layer win over an earlier layer", () => {
    const config = new Config([{ maxIterations: 5 }, { maxIterations: 9 }]);

    expect(config.values.maxIterations).toBe(9);
  });
});
