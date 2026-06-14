import { describe, expect, test } from "bun:test";
import { Loader } from "../../src/permissions/loader.ts";

describe("Loader.stringArray", () => {
  test("non-array returns a fresh copy of the fallback", () => {
    const fallback = ["a", "b"];
    const result = Loader.stringArray(undefined, fallback);

    expect(result).toEqual(["a", "b"]);
    expect(result).not.toBe(fallback);
  });

  test("filters blank and non-string entries and trims", () => {
    expect(Loader.stringArray([" read ", "", 5, null, "write"], ["x"])).toEqual(["read", "write"]);
  });
});

describe("Loader.positiveInt", () => {
  test("floors a finite positive number", () => {
    expect(Loader.positiveInt(160.9, 1)).toBe(160);
  });

  test("rejects zero, negative, non-finite, and non-number", () => {
    expect(Loader.positiveInt(0, 7)).toBe(7);
    expect(Loader.positiveInt(-5, 7)).toBe(7);
    expect(Loader.positiveInt(Number.NaN, 7)).toBe(7);
    expect(Loader.positiveInt(Number.POSITIVE_INFINITY, 7)).toBe(7);
    expect(Loader.positiveInt("160", 7)).toBe(7);
  });
});

describe("Loader.normalizeJudge", () => {
  test("non-record returns a copy of the fallback", () => {
    const result = Loader.normalizeJudge(undefined);

    expect(result).toEqual(Loader.FALLBACK.judge);
    expect(result).not.toBe(Loader.FALLBACK.judge);
  });

  test("enabled only true coerces, model requires a slash", () => {
    expect(Loader.normalizeJudge({ enabled: "yes" }).enabled).toBe(false);
    expect(Loader.normalizeJudge({ enabled: true }).enabled).toBe(true);
    expect(Loader.normalizeJudge({ model: "noslash" }).model).toBe(Loader.FALLBACK.judge.model);
    expect(Loader.normalizeJudge({ model: "x/y" }).model).toBe("x/y");
  });

  test("maxRisk only risky coerces; timeouts and tokens use positiveInt", () => {
    expect(Loader.normalizeJudge({ maxRisk: "risky" }).maxRisk).toBe("risky");
    expect(Loader.normalizeJudge({ maxRisk: "whatever" }).maxRisk).toBe("safe");
    expect(Loader.normalizeJudge({ timeoutMs: -1 }).timeoutMs).toBe(Loader.FALLBACK.judge.timeoutMs);
    expect(Loader.normalizeJudge({ maxTokens: 50.7 }).maxTokens).toBe(50);
  });
});

describe("Loader.normalizeConfig", () => {
  test("empty raw produces every documented default", () => {
    expect(Loader.normalizeConfig({})).toEqual(Loader.FALLBACK);
  });

  test("invalid mode falls back to ask", () => {
    expect(Loader.normalizeConfig({ mode: "bogus" }).mode).toBe("ask");
    expect(Loader.normalizeConfig({ mode: "yolo" }).mode).toBe("yolo");
  });

  test("headless only allow coerces", () => {
    expect(Loader.normalizeConfig({ headless: "allow" }).headless).toBe("allow");
    expect(Loader.normalizeConfig({ headless: "whatever" }).headless).toBe("deny");
  });

  test("subagentBridge only false disables", () => {
    expect(Loader.normalizeConfig({ subagentBridge: false }).subagentBridge).toBe(false);
    expect(Loader.normalizeConfig({ subagentBridge: "no" }).subagentBridge).toBe(true);
    expect(Loader.normalizeConfig({}).subagentBridge).toBe(true);
  });

  test("rule lists are sanitized", () => {
    const config = Loader.normalizeConfig({
      allow: [{ tool: "read" }, "bad"],
      deny: "not-an-array",
    });

    expect(config.allow).toEqual([{ tool: "read" }]);
    expect(config.deny).toEqual([]);
  });
});

describe("Loader.deepMerge", () => {
  test("recurses only on record+record and skips undefined overrides", () => {
    const merged = Loader.deepMerge(
      { judge: { enabled: false, model: "a/b" }, mode: "ask" },
      { judge: { enabled: true }, mode: undefined },
    );

    expect(merged).toEqual({ judge: { enabled: true, model: "a/b" }, mode: "ask" });
  });

  test("non-record override replaces wholesale", () => {
    expect(Loader.deepMerge({ a: { x: 1 } }, { a: 5 })).toEqual({ a: 5 });
  });
});

describe("Loader.fromRaw merge contract", () => {
  test("project overrides global overrides shipped, by section", () => {
    const shipped = { mode: "ask", judge: { enabled: false, timeoutMs: 20000 } };
    const global = { permissions: { mode: "write", judge: { enabled: true } } };
    const project = { permissions: { mode: "yolo" } };
    const config = Loader.fromRaw(shipped, global, project);

    expect(config.mode).toBe("yolo");
    expect(config.judge.enabled).toBe(true);
    expect(config.judge.timeoutMs).toBe(20000);
  });

  test("ignores override files that lack a permissions section", () => {
    const config = Loader.fromRaw({ mode: "write" }, { other: {} }, null);

    expect(config.mode).toBe("write");
  });

  test("null shipped still yields defaults", () => {
    expect(Loader.fromRaw(null, null, null)).toEqual(Loader.FALLBACK);
  });
});
