import { describe, expect, test } from "bun:test";
import { Config } from "../../src/skills/config.ts";

describe("Config defaults", () => {
  test("all sources null yields shipped defaults", () => {
    const config = new Config({ shipped: null, global: null, project: null });
    expect(config.values).toEqual({ global: true, project: true, dirs: [] });
    expect(config.dirsDiagnostics).toEqual([]);
  });

  test("static defaults are exact", () => {
    expect(Config.defaults).toEqual({ global: true, project: true, dirs: [] });
  });

  test("dirs default is a fresh copy, not the shared reference", () => {
    const config = new Config({ shipped: null, global: null, project: null });
    expect(config.values.dirs).not.toBe(Config.defaults.dirs);
  });

  test("empty shipped record yields defaults", () => {
    const config = new Config({ shipped: {}, global: null, project: null });
    expect(config.values).toEqual({ global: true, project: true, dirs: [] });
    expect(config.dirsDiagnostics).toEqual([]);
  });

  test("shipped record without skills section yields defaults", () => {
    const config = new Config({ shipped: { other: { global: false } }, global: null, project: null });
    expect(config.values).toEqual({ global: true, project: true, dirs: [] });
  });
});

describe("Config shipped layer", () => {
  test("shipped skills section spreads whole object over defaults", () => {
    const config = new Config({
      shipped: { skills: { global: false, project: false, dirs: ["a"] } },
      global: null,
      project: null,
    });
    expect(config.values).toEqual({ global: false, project: false, dirs: ["a"] });
  });

  test("non-record shipped is ignored", () => {
    const config = new Config({ shipped: ["nope"], global: null, project: null });
    expect(config.values).toEqual({ global: true, project: true, dirs: [] });
  });

  test("shipped skills section that is an array is ignored", () => {
    const config = new Config({ shipped: { skills: ["x"] }, global: null, project: null });
    expect(config.values).toEqual({ global: true, project: true, dirs: [] });
  });
});

describe("Config merge order and shallow spread", () => {
  test("global skills section overrides shipped", () => {
    const config = new Config({
      shipped: { skills: { global: true, project: true, dirs: [] } },
      global: { skills: { global: false } },
      project: null,
    });
    expect(config.values.global).toBe(false);
    expect(config.values.project).toBe(true);
  });

  test("project skills section overrides global section", () => {
    const config = new Config({
      shipped: { skills: { global: true } },
      global: { skills: { project: false } },
      project: { skills: { project: true } },
    });
    expect(config.values.project).toBe(true);
  });

  test("shallow spread replaces dirs wholesale, no inheritance", () => {
    const config = new Config({
      shipped: { skills: { dirs: ["shipped"] } },
      global: { skills: { dirs: ["global"] } },
      project: { skills: { global: false } },
    });
    expect(config.values.dirs).toEqual(["global"]);
    expect(config.values.global).toBe(false);
  });

  test("project section absent leaves global section in effect", () => {
    const config = new Config({
      shipped: null,
      global: { skills: { dirs: ["g"] } },
      project: { notskills: true },
    });
    expect(config.values.dirs).toEqual(["g"]);
  });

  test("global without skills key is ignored", () => {
    const config = new Config({
      shipped: null,
      global: { other: { global: false } },
      project: null,
    });
    expect(config.values.global).toBe(true);
  });

  test("skills section that is an array is not a record and ignored", () => {
    const config = new Config({
      shipped: null,
      global: { skills: ["x"] },
      project: null,
    });
    expect(config.values).toEqual({ global: true, project: true, dirs: [] });
  });
});

describe("Config normalize validation", () => {
  test("non-boolean global and project fall back to defaults", () => {
    const config = new Config({
      shipped: { skills: { global: "yes", project: 0 } },
      global: null,
      project: null,
    });
    expect(config.values.global).toBe(true);
    expect(config.values.project).toBe(true);
  });

  test("false boolean is preserved", () => {
    const config = new Config({
      shipped: { skills: { global: false, project: false } },
      global: null,
      project: null,
    });
    expect(config.values.global).toBe(false);
    expect(config.values.project).toBe(false);
  });

  test("non-array dirs falls back to fresh default copy", () => {
    const config = new Config({ shipped: { skills: { dirs: "nope" } }, global: null, project: null });
    expect(config.values.dirs).toEqual([]);
    expect(config.values.dirs).not.toBe(Config.defaults.dirs);
  });

  test("array dirs keeps only non-empty strings", () => {
    const config = new Config({
      shipped: { skills: { dirs: ["a", "", "b", 3, null, "c"] } },
      global: null,
      project: null,
    });
    expect(config.values.dirs).toEqual(["a", "b", "c"]);
  });

  test("dropped dir entries are surfaced as diagnostics with index and reason", () => {
    const config = new Config({
      shipped: { skills: { dirs: ["a", "", 3] } },
      global: null,
      project: null,
    });
    expect(config.dirsDiagnostics).toEqual([
      { index: 1, value: "", reason: "empty-string" },
      { index: 2, value: 3, reason: "not-a-string" },
    ]);
  });

  test("valid dirs produce no diagnostics", () => {
    const config = new Config({ shipped: { skills: { dirs: ["a", "b"] } }, global: null, project: null });
    expect(config.dirsDiagnostics).toEqual([]);
  });
});

describe("Config helpers", () => {
  test("isRecord rejects arrays and null", () => {
    expect(Config.isRecord({})).toBe(true);
    expect(Config.isRecord([])).toBe(false);
    expect(Config.isRecord(null)).toBe(false);
    expect(Config.isRecord(42)).toBe(false);
  });

  test("asRecord returns record or null", () => {
    expect(Config.asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(Config.asRecord([])).toBeNull();
    expect(Config.asRecord(null)).toBeNull();
  });

  test("section extracts skills record only", () => {
    expect(Config.section({ skills: { global: false } })).toEqual({ global: false });
    expect(Config.section({ skills: ["x"] })).toBeNull();
    expect(Config.section({ other: {} })).toBeNull();
    expect(Config.section(null)).toBeNull();
  });
});
