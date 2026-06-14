import { describe, expect, test } from "bun:test";
import { Config } from "../../src/sessions/text.ts";

describe("Config", () => {
  test("defaults when no overlays", () => {
    const cfg = Config.fromRaw(null, null, null);

    expect(cfg).toEqual({
      listLimit: 20,
      readLimit: 60,
      searchLimit: 50,
      excerptChars: 160,
      contextEntries: 3,
      allowSwitch: false,
      btwBudget: 12000,
      btwMaxTokens: 4096,
    });
  });

  test("shipped config layered first", () => {
    const cfg = Config.fromRaw({ listLimit: 5 }, null, null);

    expect(cfg.listLimit).toBe(5);
  });

  test("global then project section wins", () => {
    const cfg = Config.fromRaw(
      { listLimit: 5 },
      { sessions: { listLimit: 10, readLimit: 100 } },
      { sessions: { listLimit: 30 } },
    );

    expect(cfg.listLimit).toBe(30);
    expect(cfg.readLimit).toBe(100);
  });

  test("overlay only applies the sessions section", () => {
    const cfg = Config.fromRaw(null, { other: { listLimit: 1 } }, null);

    expect(cfg.listLimit).toBe(20);
  });

  test("clampInt lower and upper bounds per key", () => {
    const cfg = Config.fromRaw(
      null,
      {
        sessions: {
          listLimit: 0,
          readLimit: 9999,
          searchLimit: 999,
          excerptChars: 1,
          contextEntries: -5,
          btwBudget: 1,
          btwMaxTokens: 999999,
        },
      },
      null,
    );

    expect(cfg.listLimit).toBe(1);
    expect(cfg.readLimit).toBe(500);
    expect(cfg.searchLimit).toBe(50);
    expect(cfg.excerptChars).toBe(40);
    expect(cfg.contextEntries).toBe(0);
    expect(cfg.btwBudget).toBe(500);
    expect(cfg.btwMaxTokens).toBe(64000);
  });

  test("non-numeric values fall back to defaults", () => {
    const cfg = Config.fromRaw(null, { sessions: { listLimit: "many", btwBudget: NaN } }, null);

    expect(cfg.listLimit).toBe(20);
    expect(cfg.btwBudget).toBe(12000);
  });

  test("floats are floored", () => {
    const cfg = Config.fromRaw(null, { sessions: { readLimit: 99.9 } }, null);

    expect(cfg.readLimit).toBe(99);
  });

  test("allowSwitch is strict boolean true", () => {
    expect(Config.fromRaw(null, { sessions: { allowSwitch: true } }, null).allowSwitch).toBe(true);
    expect(Config.fromRaw(null, { sessions: { allowSwitch: "true" } }, null).allowSwitch).toBe(false);
    expect(Config.fromRaw(null, { sessions: { allowSwitch: 1 } }, null).allowSwitch).toBe(false);
  });

  test("deepMerge keeps base keys not in override and recurses on records", () => {
    const merged = Config.deepMerge({ a: 1, nested: { x: 1, y: 2 } }, { b: 2, nested: { y: 9 } });

    expect(merged).toEqual({ a: 1, b: 2, nested: { x: 1, y: 9 } });
  });

  test("deepMerge ignores undefined override values", () => {
    const merged = Config.deepMerge({ a: 1 }, { a: undefined });

    expect(merged.a).toBe(1);
  });
});
