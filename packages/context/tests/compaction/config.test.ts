import { describe, expect, test } from "bun:test";
import { Config, isActivePercent, isRecord, numberOr, stringOr } from "../../src/compaction/index.ts";

const shipped = {
  strategy: "supersede",
  dropOverBytes: 20480,
  keepRecentTokens: 20000,
  preemptPct: 85,
  promotePct: 90,
  shakeOverBytes: 10240,
  handoffPath: ".pi/handoff.md",
  handoffChars: 60000,
  handoffMaxTokens: 4096,
  promotion: { enabled: true, ladder: [] },
};

describe("primitive validators", () => {
  test("isRecord rejects arrays and null", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  test("numberOr keeps finite non-negative numbers", () => {
    expect(numberOr(5, 1)).toBe(5);
    expect(numberOr(0, 1)).toBe(0);
    expect(numberOr(-1, 1)).toBe(1);
    expect(numberOr(Number.NaN, 1)).toBe(1);
    expect(numberOr(Infinity, 1)).toBe(1);
    expect(numberOr("3", 1)).toBe(1);
  });

  test("stringOr keeps non-empty trimmed strings", () => {
    expect(stringOr("a", "z")).toBe("a");
    expect(stringOr("   ", "z")).toBe("z");
    expect(stringOr("", "z")).toBe("z");
    expect(stringOr(7, "z")).toBe("z");
  });

  test("isActivePercent enforces open 0..100 range", () => {
    expect(isActivePercent(50)).toBe(true);
    expect(isActivePercent(0)).toBe(false);
    expect(isActivePercent(100)).toBe(false);
    expect(isActivePercent(-1)).toBe(false);
    expect(isActivePercent(120)).toBe(false);
  });
});

describe("Config.resolve", () => {
  test("no overrides returns shipped defaults", () => {
    const config = new Config(shipped);

    expect(config.resolve([])).toEqual(shipped);
  });

  test("falls back to defaults for invalid values", () => {
    const config = new Config(shipped);
    const effective = config.resolve([{ dropOverBytes: -3, strategy: "  ", preemptPct: "high" }]);

    expect(effective.dropOverBytes).toBe(20480);
    expect(effective.strategy).toBe("supersede");
    expect(effective.preemptPct).toBe(85);
  });

  test("project override wins over user override", () => {
    const config = new Config(shipped);
    const effective = config.resolve([{ preemptPct: 70 }, { preemptPct: 60 }]);

    expect(effective.preemptPct).toBe(60);
  });

  test("deep-merges the promotion section and filters the ladder", () => {
    const config = new Config(shipped);
    const effective = config.resolve([
      { promotion: { enabled: false, ladder: ["openai/gpt", "  ", 5, "anthropic/claude"] } },
    ]);

    expect(effective.promotion.enabled).toBe(false);
    expect(effective.promotion.ladder).toEqual(["openai/gpt", "anthropic/claude"]);
  });

  test("non-supersede strategy is preserved verbatim", () => {
    const config = new Config(shipped);

    expect(config.resolve([{ strategy: "off" }]).strategy).toBe("off");
  });

  test("missing promotion in overrides keeps default enabled, empty ladder", () => {
    const config = new Config(shipped);
    const effective = config.resolve([{ shakeOverBytes: 2048 }]);

    expect(effective.promotion).toEqual({ enabled: true, ladder: [] });
    expect(effective.shakeOverBytes).toBe(2048);
  });

  test("ladder must be an array else empties", () => {
    const config = new Config(shipped);

    expect(config.resolve([{ promotion: { ladder: "openai/gpt" } }]).promotion.ladder).toEqual([]);
  });

  test("preemptPct of zero is accepted as stored value", () => {
    const config = new Config(shipped);

    expect(config.resolve([{ preemptPct: 0 }]).preemptPct).toBe(0);
  });
});
