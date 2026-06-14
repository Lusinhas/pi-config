import { describe, expect, it } from "bun:test";
import { Config } from "../../src/memory/index.ts";

describe("Config defaults", () => {
  it("matches the shipped byte-identical defaults with no layers", () => {
    expect(new Config([]).values).toEqual({
      injectBudget: 2000,
      consolidateEvery: 0,
      consolidateOnQuit: true,
      model: "",
      maxFacts: 3,
      recallBudget: 6000,
      maxTopicBytes: 65536,
      transcriptBudget: 12000,
    });
  });

  it("ignores non-record layers", () => {
    expect(new Config([undefined, null, 42, "x", [1, 2]]).values).toEqual(Config.defaults);
  });
});

describe("Config.isRecord", () => {
  it("accepts plain objects only", () => {
    expect(Config.isRecord({})).toBe(true);
    expect(Config.isRecord({ a: 1 })).toBe(true);
    expect(Config.isRecord(null)).toBe(false);
    expect(Config.isRecord([])).toBe(false);
    expect(Config.isRecord(5)).toBe(false);
    expect(Config.isRecord("s")).toBe(false);
    expect(Config.isRecord(undefined)).toBe(false);
  });
});

describe("Config.deepMerge", () => {
  it("recurses only when both sides are plain objects", () => {
    const merged = Config.deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } });

    expect(merged).toEqual({ a: { x: 1, y: 3, z: 4 } });
  });

  it("override scalar replaces object and vice versa", () => {
    expect(Config.deepMerge({ a: { x: 1 } }, { a: 5 })).toEqual({ a: 5 });
    expect(Config.deepMerge({ a: 5 }, { a: { x: 1 } })).toEqual({ a: { x: 1 } });
  });

  it("array override wins (not merged element-wise)", () => {
    expect(Config.deepMerge({ a: [1, 2, 3] }, { a: [9] })).toEqual({ a: [9] });
  });

  it("skips undefined override values", () => {
    expect(Config.deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it("does not mutate the base object", () => {
    const base = { a: { x: 1 } };
    Config.deepMerge(base, { a: { y: 2 } });

    expect(base).toEqual({ a: { x: 1 } });
  });
});

describe("Config.num", () => {
  it("floors finite numbers at or above min", () => {
    expect(Config.num(10.9, 0, 0)).toBe(10);
    expect(Config.num(100, 0, 100)).toBe(100);
  });

  it("falls back below min, on NaN, Infinity, and non-numbers", () => {
    expect(Config.num(99, 7, 100)).toBe(7);
    expect(Config.num(Number.NaN, 7, 0)).toBe(7);
    expect(Config.num(Number.POSITIVE_INFINITY, 7, 0)).toBe(7);
    expect(Config.num("5", 7, 0)).toBe(7);
    expect(Config.num(undefined, 7, 0)).toBe(7);
  });
});

describe("Config.sanitize per-key boundaries", () => {
  const sanitize = (raw: Record<string, unknown>) => Config.sanitize({ ...Config.defaults, ...raw });

  it("injectBudget at min-1 / min / min+1", () => {
    expect(sanitize({ injectBudget: 99 }).injectBudget).toBe(2000);
    expect(sanitize({ injectBudget: 100 }).injectBudget).toBe(100);
    expect(sanitize({ injectBudget: 101.9 }).injectBudget).toBe(101);
  });

  it("consolidateEvery allows zero and floors", () => {
    expect(sanitize({ consolidateEvery: 0 }).consolidateEvery).toBe(0);
    expect(sanitize({ consolidateEvery: -1 }).consolidateEvery).toBe(0);
    expect(sanitize({ consolidateEvery: 3.7 }).consolidateEvery).toBe(3);
  });

  it("consolidateOnQuit accepts boolean only", () => {
    expect(sanitize({ consolidateOnQuit: false }).consolidateOnQuit).toBe(false);
    expect(sanitize({ consolidateOnQuit: "no" }).consolidateOnQuit).toBe(true);
    expect(sanitize({ consolidateOnQuit: 0 }).consolidateOnQuit).toBe(true);
  });

  it("model accepts any string including empty", () => {
    expect(sanitize({ model: "anthropic/x" }).model).toBe("anthropic/x");
    expect(sanitize({ model: "" }).model).toBe("");
    expect(sanitize({ model: 5 }).model).toBe("");
  });

  it("maxFacts caps at 10 and floors to default below 1", () => {
    expect(sanitize({ maxFacts: 0 }).maxFacts).toBe(3);
    expect(sanitize({ maxFacts: 1 }).maxFacts).toBe(1);
    expect(sanitize({ maxFacts: 10 }).maxFacts).toBe(10);
    expect(sanitize({ maxFacts: 11 }).maxFacts).toBe(10);
    expect(sanitize({ maxFacts: Number.NaN }).maxFacts).toBe(3);
    expect(sanitize({ maxFacts: Number.POSITIVE_INFINITY }).maxFacts).toBe(3);
    expect(sanitize({ maxFacts: "8" }).maxFacts).toBe(3);
  });

  it("recallBudget at min-1 / min / min+1", () => {
    expect(sanitize({ recallBudget: 499 }).recallBudget).toBe(6000);
    expect(sanitize({ recallBudget: 500 }).recallBudget).toBe(500);
    expect(sanitize({ recallBudget: 501 }).recallBudget).toBe(501);
  });

  it("maxTopicBytes at min-1 / min / min+1", () => {
    expect(sanitize({ maxTopicBytes: 4095 }).maxTopicBytes).toBe(65536);
    expect(sanitize({ maxTopicBytes: 4096 }).maxTopicBytes).toBe(4096);
    expect(sanitize({ maxTopicBytes: 4097 }).maxTopicBytes).toBe(4097);
  });

  it("transcriptBudget at min-1 / min / min+1", () => {
    expect(sanitize({ transcriptBudget: 999 }).transcriptBudget).toBe(12000);
    expect(sanitize({ transcriptBudget: 1000 }).transcriptBudget).toBe(1000);
    expect(sanitize({ transcriptBudget: 1001 }).transcriptBudget).toBe(1001);
  });
});

describe("Config merge layering", () => {
  it("project layer wins over user layer over shipped", () => {
    const shipped = { ...Config.defaults };
    const user = { injectBudget: 300, model: "user/m" };
    const project = { injectBudget: 400 };
    const cfg = new Config([shipped, user, project]).values;

    expect(cfg.injectBudget).toBe(400);
    expect(cfg.model).toBe("user/m");
  });

  it("invalid override value falls back to shipped default for that key", () => {
    const cfg = new Config([{ ...Config.defaults }, { recallBudget: 10 }]).values;

    expect(cfg.recallBudget).toBe(6000);
  });
});
