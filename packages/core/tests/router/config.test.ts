import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Config } from "../../src/router/index.ts";

const ROUTER_DEFAULTS = {
  roles: {
    default: "claude-opus-4-8",
    smol: "claude-haiku-4-5",
    plan: { model: "claude-opus-4-8", thinking: "high" },
    commit: { model: "claude-haiku-4-5", thinking: "off" },
    review: { model: "claude-opus-4-8", thinking: "medium" }
  },
  fallback: {
    enabled: true,
    threshold: 2,
    failWindowSec: 120,
    restoreAfterMin: 10,
    chains: {
      "claude-opus": ["claude-sonnet-4-6", "claude-haiku-4-5"],
      "claude-sonnet": ["claude-haiku-4-5"]
    }
  },
  profiles: {
    deep: { model: "claude-opus-4-8", thinking: "xhigh" },
    fast: { model: "claude-haiku-4-5", thinking: "off" },
    readonly: { tools: ["read", "grep", "find", "ls"] }
  },
  maxBudgetTokens: 100000
};

function shippedRouter(): unknown {
  const path = fileURLToPath(new URL("../../config.json", import.meta.url));

  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8"));

    if (parsed && typeof parsed === "object" && parsed.router) {
      return parsed.router;
    }
  }

  return ROUTER_DEFAULTS;
}

const shipped = shippedRouter();

describe("Config.parseRoles", () => {
  test("string value becomes trimmed model target", () => {
    const roles = Config.parseRoles({ a: "  claude-opus-4-8  " });

    expect(roles.a).toEqual({ model: "claude-opus-4-8" });
  });

  test("record value keeps valid thinking, drops invalid", () => {
    const roles = Config.parseRoles({
      a: { model: "m", thinking: "high" },
      b: { model: "m", thinking: "bogus" }
    });

    expect(roles.a).toEqual({ model: "m", thinking: "high" });
    expect(roles.b).toEqual({ model: "m" });
  });

  test("skips empty names, empty strings, and records without model", () => {
    const roles = Config.parseRoles({ "  ": "x", a: "", b: {}, c: { model: "   " }, d: "ok" });

    expect(Object.keys(roles)).toEqual(["d"]);
  });

  test("non-record input yields empty roles", () => {
    expect(Config.parseRoles("nope")).toEqual({});
    expect(Config.parseRoles(null)).toEqual({});
    expect(Config.parseRoles([1, 2])).toEqual({});
  });

  test("preserves insertion order", () => {
    const roles = Config.parseRoles({ z: "a", m: "b", a: "c" });

    expect(Object.keys(roles)).toEqual(["z", "m", "a"]);
  });
});

describe("Config.parseFallback", () => {
  test("non-record falls back to defaults with empty chains", () => {
    expect(Config.parseFallback("x")).toEqual({
      enabled: true,
      threshold: 2,
      failWindowSec: 120,
      restoreAfterMin: 10,
      chains: {}
    });
  });

  test("threshold floors and clamps to at least 1", () => {
    expect(Config.parseFallback({ threshold: 3.9 }).threshold).toBe(3);
    expect(Config.parseFallback({ threshold: 0 }).threshold).toBe(2);
    expect(Config.parseFallback({ threshold: -5 }).threshold).toBe(2);
    expect(Config.parseFallback({ threshold: 0.5 }).threshold).toBe(1);
  });

  test("positive numbers accepted, invalid falls back to default", () => {
    expect(Config.parseFallback({ failWindowSec: 30 }).failWindowSec).toBe(30);
    expect(Config.parseFallback({ failWindowSec: 0 }).failWindowSec).toBe(120);
    expect(Config.parseFallback({ failWindowSec: -1 }).failWindowSec).toBe(120);
    expect(Config.parseFallback({ failWindowSec: Number.POSITIVE_INFINITY }).failWindowSec).toBe(120);
  });

  test("bounds runaway windows to sane ceilings", () => {
    expect(Config.parseFallback({ failWindowSec: 999999999 }).failWindowSec).toBe(Config.MAX_WINDOW_SEC);
    expect(Config.parseFallback({ restoreAfterMin: 999999999 }).restoreAfterMin).toBe(Config.MAX_RESTORE_MIN);
    expect(Config.parseFallback({ threshold: 999999999 }).threshold).toBe(Config.MAX_THRESHOLD);
  });

  test("chains keep only string entries, drop empty chains and blank keys", () => {
    const config = Config.parseFallback({
      chains: {
        "  opus  ": ["a", "  b  ", 3, ""],
        sonnet: [],
        "   ": ["x"],
        bad: "notarray"
      }
    });

    expect(config.chains).toEqual({ opus: ["a", "b"] });
  });

  test("enabled only accepts boolean", () => {
    expect(Config.parseFallback({ enabled: false }).enabled).toBe(false);
    expect(Config.parseFallback({ enabled: "yes" }).enabled).toBe(true);
  });
});

describe("Config.parseProfiles", () => {
  test("reserved name off is skipped case-insensitively", () => {
    const profiles = Config.parseProfiles({ OFF: { model: "m" }, off: { model: "m" } });

    expect(profiles).toEqual({});
  });

  test("collects populated fields and trims them", () => {
    const profiles = Config.parseProfiles({
      a: { model: " m ", thinking: "xhigh", theme: " dark ", tools: [" read ", "", 4, "ls"], style: " s " }
    });

    expect(profiles.a).toEqual({ model: "m", thinking: "xhigh", theme: "dark", tools: ["read", "ls"], style: "s" });
  });

  test("skips entries with no populated field", () => {
    const profiles = Config.parseProfiles({ a: {}, b: { model: "   " }, c: { thinking: "bad" } });

    expect(Object.keys(profiles)).toEqual([]);
  });

  test("empty tools array is kept as populated field", () => {
    const profiles = Config.parseProfiles({ a: { tools: [] } });

    expect(profiles.a).toEqual({ tools: [] });
  });
});

describe("Config.maxBudgetTokens", () => {
  test("floors valid values at or above minimum", () => {
    expect(Config.maxBudgetTokens(2048.7)).toBe(2048);
    expect(Config.maxBudgetTokens(1024)).toBe(1024);
  });

  test("falls back below minimum or invalid", () => {
    expect(Config.maxBudgetTokens(1023)).toBe(100000);
    expect(Config.maxBudgetTokens("big")).toBe(100000);
    expect(Config.maxBudgetTokens(Number.NaN)).toBe(100000);
    expect(Config.maxBudgetTokens(Number.POSITIVE_INFINITY)).toBe(100000);
  });
});

describe("Config.deepMerge and overlayFrom", () => {
  test("recursive merge with override winning, undefined ignored", () => {
    const merged = Config.deepMerge({ a: { x: 1, y: 2 }, b: 5 }, { a: { y: 9, z: 3 }, b: undefined });

    expect(merged).toEqual({ a: { x: 1, y: 9, z: 3 }, b: 5 });
  });

  test("non-record override returns base unchanged", () => {
    const base = { a: 1 };

    expect(Config.deepMerge(base, "x")).toBe(base);
    expect(Config.deepMerge(base, [1])).toBe(base);
  });

  test("overlayFrom pulls the router subsection", () => {
    expect(Config.overlayFrom({ router: { roles: {} }, other: 1 })).toEqual({ roles: {} });
    expect(Config.overlayFrom("x")).toBeUndefined();
  });
});

describe("Config.fromRaw layering", () => {
  test("project wins over user wins over shipped", () => {
    const config = Config.fromRaw(
      { roles: { a: "shipped" }, maxBudgetTokens: 2048 },
      { router: { roles: { a: "user", b: "user-b" } } },
      { router: { roles: { a: "project" } } }
    );

    expect(config.roles.a).toEqual({ model: "project" });
    expect(config.roles.b).toEqual({ model: "user-b" });
    expect(config.maxBudgetTokens).toBe(2048);
  });

  test("shipped chains survive a malformed non-record user fallback", () => {
    const config = Config.fromRaw(shipped, { router: { fallback: "broken" } }, undefined);

    expect(config.fallback.chains).toEqual({
      "claude-opus": ["claude-sonnet-4-6", "claude-haiku-4-5"],
      "claude-sonnet": ["claude-haiku-4-5"]
    });
    expect(config.fallback.enabled).toBe(true);
    expect(config.fallback.threshold).toBe(2);
  });

  test("shipped config parses to documented defaults", () => {
    const config = Config.fromRaw(shipped, undefined, undefined);

    expect(config.roles.default).toEqual({ model: "claude-opus-4-8" });
    expect(config.roles.plan).toEqual({ model: "claude-opus-4-8", thinking: "high" });
    expect(config.profiles.readonly).toEqual({ tools: ["read", "grep", "find", "ls"] });
    expect(config.maxBudgetTokens).toBe(100000);
    expect(config.fallback.restoreAfterMin).toBe(10);
  });

  test("user fallback chains override shipped per merge semantics", () => {
    const config = Config.fromRaw(shipped, { router: { fallback: { chains: { gpt: ["x"] } } } }, undefined);

    expect(config.fallback.chains.gpt).toEqual(["x"]);
    expect(config.fallback.chains["claude-opus"]).toEqual(["claude-sonnet-4-6", "claude-haiku-4-5"]);
  });
});
