import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, DEFAULTS } from "../../src/styles/config.ts";

describe("Config defaults and merge", () => {
  test("uses shipped defaults when no overrides", () => {
    const result = Config.fromLayers({ active: "default", userDir: "~/.pi/agent/styles" }, null, null);
    expect(result).toEqual({ active: "default", userDir: "~/.pi/agent/styles" });
  });

  test("global section overrides shipped, project wins over global", () => {
    const result = Config.fromLayers(
      { active: "default", userDir: "~/.pi/agent/styles" },
      { active: "explanatory" },
      { active: "pragmatic" },
    );
    expect(result.active).toBe("pragmatic");
  });

  test("global overrides shipped when no project layer", () => {
    const result = Config.fromLayers(
      { active: "default", userDir: "~/.pi/agent/styles" },
      { active: "learning", userDir: "/abs/styles" },
      null,
    );
    expect(result.active).toBe("learning");
    expect(result.userDir).toBe("/abs/styles");
  });

  test("invalid active falls back to default via coerceName", () => {
    expect(Config.fromLayers({ active: "" }, null, null).active).toBe(DEFAULTS.active);
    expect(Config.fromLayers({ active: "   " }, null, null).active).toBe(DEFAULTS.active);
    expect(Config.fromLayers({ active: 42 }, null, null).active).toBe(DEFAULTS.active);
    expect(Config.fromLayers({ active: null }, null, null).active).toBe(DEFAULTS.active);
  });

  test("active is trimmed", () => {
    expect(Config.fromLayers({ active: "  proactive  " }, null, null).active).toBe("proactive");
  });

  test("invalid userDir falls back to default", () => {
    expect(Config.fromLayers({ userDir: "" }, null, null).userDir).toBe(DEFAULTS.userDir);
    expect(Config.fromLayers({ userDir: 7 }, null, null).userDir).toBe(DEFAULTS.userDir);
  });

  test("ignores non-record layers", () => {
    const result = Config.fromLayers({ active: "default", userDir: "~/.pi/agent/styles" }, [] as unknown as Record<string, unknown>, "x" as unknown as Record<string, unknown>);
    expect(result.active).toBe("default");
  });
});

describe("Config.section", () => {
  test("extracts styles section", () => {
    expect(Config.section({ styles: { active: "x" } })).toEqual({ active: "x" });
  });

  test("returns null when no styles record", () => {
    expect(Config.section({ other: 1 })).toBeNull();
    expect(Config.section({ styles: "no" })).toBeNull();
    expect(Config.section(null)).toBeNull();
    expect(Config.section(undefined)).toBeNull();
  });
});

describe("Config.expandHome", () => {
  test("bare tilde expands to homedir", () => {
    expect(Config.expandHome("~")).toBe(homedir());
  });

  test("tilde slash expands", () => {
    expect(Config.expandHome("~/.pi/agent/styles")).toBe(join(homedir(), ".pi/agent/styles"));
  });

  test("absolute path unchanged", () => {
    expect(Config.expandHome("/var/styles")).toBe("/var/styles");
  });

  test("relative path without tilde unchanged", () => {
    expect(Config.expandHome("styles")).toBe("styles");
    expect(Config.expandHome("~tilde/notexpanded")).toBe("~tilde/notexpanded");
  });
});

describe("Config.deepMerge", () => {
  test("merges nested records", () => {
    const merged = Config.deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } });
    expect(merged).toEqual({ a: { x: 1, y: 3, z: 4 } });
  });

  test("override replaces non-record with value", () => {
    expect(Config.deepMerge({ a: 1 }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
    expect(Config.deepMerge({ a: { b: 2 } }, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("Config.isRecord", () => {
  test("rejects arrays and null", () => {
    expect(Config.isRecord([])).toBe(false);
    expect(Config.isRecord(null)).toBe(false);
    expect(Config.isRecord("x")).toBe(false);
    expect(Config.isRecord({})).toBe(true);
  });
});
