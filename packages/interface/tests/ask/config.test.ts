import { describe, expect, test } from "bun:test";
import { Config } from "../../src/ask/config.ts";

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

  test("override replaces scalar with record and vice versa", () => {
    expect(Config.deepMerge({ a: 1 }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
    expect(Config.deepMerge({ a: { b: 2 } }, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("Config.fromRaw merge order and defaults", () => {
  test("uses defaults when everything is null", () => {
    expect(Config.fromRaw(null, null, null)).toEqual(Config.DEFAULTS);
  });

  test("shipped config overrides defaults", () => {
    const out = Config.fromRaw({ doneLabel: "Submit" }, null, null);

    expect(out.doneLabel).toBe("Submit");
  });

  test("global ask section overrides shipped", () => {
    const out = Config.fromRaw({ doneLabel: "Submit" }, { ask: { doneLabel: "Confirm" } }, null);

    expect(out.doneLabel).toBe("Confirm");
  });

  test("project ask section wins over global", () => {
    const out = Config.fromRaw(
      { doneLabel: "Submit" },
      { ask: { doneLabel: "Confirm" } },
      { ask: { doneLabel: "Go" } },
    );

    expect(out.doneLabel).toBe("Go");
  });

  test("ignores non-record ask sections", () => {
    const out = Config.fromRaw(null, { ask: "nope" }, { ask: [1, 2] });

    expect(out).toEqual(Config.DEFAULTS);
  });
});

describe("Config validation per key", () => {
  test("defaultTimeoutSec accepts finite non-negative number", () => {
    expect(Config.fromRaw({ defaultTimeoutSec: 30 }, null, null).defaultTimeoutSec).toBe(30);
    expect(Config.fromRaw({ defaultTimeoutSec: 0 }, null, null).defaultTimeoutSec).toBe(0);
  });

  test("defaultTimeoutSec falls back on negative, NaN, Infinity, or wrong type", () => {
    expect(Config.fromRaw({ defaultTimeoutSec: -1 }, null, null).defaultTimeoutSec).toBe(0);
    expect(Config.fromRaw({ defaultTimeoutSec: Number.NaN }, null, null).defaultTimeoutSec).toBe(0);
    expect(Config.fromRaw({ defaultTimeoutSec: Number.POSITIVE_INFINITY }, null, null).defaultTimeoutSec).toBe(0);
    expect(Config.fromRaw({ defaultTimeoutSec: "5" }, null, null).defaultTimeoutSec).toBe(0);
  });

  test("labels are trimmed when valid", () => {
    const out = Config.fromRaw({ otherLabel: "  Custom  ", doneLabel: "  OK  " }, null, null);

    expect(out.otherLabel).toBe("Custom");
    expect(out.doneLabel).toBe("OK");
  });

  test("labels fall back on empty, whitespace, or wrong type", () => {
    expect(Config.fromRaw({ otherLabel: "   " }, null, null).otherLabel).toBe(Config.DEFAULTS.otherLabel);
    expect(Config.fromRaw({ otherLabel: "" }, null, null).otherLabel).toBe(Config.DEFAULTS.otherLabel);
    expect(Config.fromRaw({ doneLabel: 42 }, null, null).doneLabel).toBe(Config.DEFAULTS.doneLabel);
  });
});
