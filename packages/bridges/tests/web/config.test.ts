import { describe, expect, test } from "bun:test";
import { Config, DEFAULTS } from "../../src/web/index.ts";

const SHIPPED = {
  numResults: 8,
  maxChars: 40000,
  cacheTtlMin: 30,
  cacheMaxEntries: 200,
  timeoutSec: 30,
  promptSnippet: true,
};

describe("Config.isRecord", () => {
  test("plain objects are records", () => {
    expect(Config.isRecord({})).toBe(true);
    expect(Config.isRecord({ a: 1 })).toBe(true);
  });

  test("arrays, null, primitives are not records", () => {
    expect(Config.isRecord([])).toBe(false);
    expect(Config.isRecord(null)).toBe(false);
    expect(Config.isRecord("x")).toBe(false);
    expect(Config.isRecord(5)).toBe(false);
  });
});

describe("Config.deepMerge", () => {
  test("nested records merge recursively", () => {
    const merged = Config.deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } });
    expect(merged).toEqual({ a: { x: 1, y: 3, z: 4 } });
  });

  test("undefined override values are skipped", () => {
    const merged = Config.deepMerge({ a: 1 }, { a: undefined as unknown as number, b: 2 });
    expect(merged).toEqual({ a: 1, b: 2 });
  });

  test("non-record override replaces record", () => {
    const merged = Config.deepMerge({ a: { x: 1 } }, { a: 9 });
    expect(merged).toEqual({ a: 9 });
  });
});

describe("Config.intBetween", () => {
  test("non-number and non-finite fall back", () => {
    expect(Config.intBetween("3", 1, 10, 7)).toBe(7);
    expect(Config.intBetween(NaN, 1, 10, 7)).toBe(7);
    expect(Config.intBetween(Infinity, 1, 10, 7)).toBe(7);
  });

  test("floors floats", () => {
    expect(Config.intBetween(5.9, 1, 10, 7)).toBe(5);
  });

  test("inclusive bounds with off-by-one", () => {
    expect(Config.intBetween(1, 1, 25, 8)).toBe(1);
    expect(Config.intBetween(25, 1, 25, 8)).toBe(25);
    expect(Config.intBetween(0, 1, 25, 8)).toBe(8);
    expect(Config.intBetween(26, 1, 25, 8)).toBe(8);
  });

  test("float just below max floors into range", () => {
    expect(Config.intBetween(25.9, 1, 25, 8)).toBe(25);
  });
});

describe("Config.booleanOr", () => {
  test("accepts only real booleans", () => {
    expect(Config.booleanOr(true, false)).toBe(true);
    expect(Config.booleanOr(false, true)).toBe(false);
    expect(Config.booleanOr("true", true)).toBe(true);
    expect(Config.booleanOr(1, false)).toBe(false);
    expect(Config.booleanOr(undefined, true)).toBe(true);
  });
});

describe("Config.stringOr", () => {
  test("trims and rejects whitespace-only", () => {
    expect(Config.stringOr("  hi  ", "d")).toBe("hi");
    expect(Config.stringOr("   ", "d")).toBe("d");
    expect(Config.stringOr("", "d")).toBe("d");
    expect(Config.stringOr(5, "d")).toBe("d");
  });
});

describe("Config.resolve", () => {
  test("shipped defaults produce DEFAULTS values", () => {
    const cfg = new Config().resolve(SHIPPED, null, null);
    expect(cfg).toEqual(DEFAULTS);
  });

  test("missing shipped still yields DEFAULTS", () => {
    const cfg = new Config().resolve(null, null, null);
    expect(cfg).toEqual(DEFAULTS);
  });

  test("global.web overrides shipped, project.web wins over global", () => {
    const cfg = new Config().resolve(
      SHIPPED,
      { web: { numResults: 5, maxChars: 1000 } },
      { web: { numResults: 12 } },
    );
    expect(cfg.numResults).toBe(12);
    expect(cfg.maxChars).toBe(1000);
  });

  test("invalid override values fall back to default per key", () => {
    const cfg = new Config().resolve(
      SHIPPED,
      { web: { numResults: 999, cacheTtlMin: -1, timeoutSec: 9999, promptSnippet: "yes", endpoint: "  " } },
      null,
    );
    expect(cfg.numResults).toBe(8);
    expect(cfg.cacheTtlMin).toBe(30);
    expect(cfg.timeoutSec).toBe(30);
    expect(cfg.promptSnippet).toBe(true);
    expect(cfg.endpoint).toBe("https://search.parallel.ai/mcp");
  });

  test("endpoint trims and stores valid override", () => {
    const cfg = new Config().resolve(SHIPPED, { web: { endpoint: "  https://example.test/mcp  " } }, null);
    expect(cfg.endpoint).toBe("https://example.test/mcp");
  });

  test("cacheTtlMin 0 is allowed and disables cache later", () => {
    const cfg = new Config().resolve(SHIPPED, { web: { cacheTtlMin: 0 } }, null);
    expect(cfg.cacheTtlMin).toBe(0);
  });

  test("ignores web sections that are not records", () => {
    const cfg = new Config().resolve(SHIPPED, { web: "nope" }, { web: [1, 2] });
    expect(cfg).toEqual(DEFAULTS);
  });
});
