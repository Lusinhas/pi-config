import { describe, expect, test } from "bun:test";
import { Config, DEFAULTS, isRecord } from "../../src/shell/config.ts";

const shipped = {
  shell: "",
  widget: true,
  widgetLimit: 6,
  sandbox: { enabled: false, mode: "loose", network: "full", writePaths: [], escape: true },
  jobs: { autoBackgroundMs: 30000, capBytes: 2097152, defaultWaitSec: 30, keepFinished: 20, notify: true },
};

describe("isRecord", () => {
  test("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(7)).toBe(false);
  });
});

describe("Config defaults", () => {
  test("shipped config without outputBytes/outputLines still defaults them", () => {
    const value = new Config(shipped, []).value;

    expect(value.outputBytes).toBe(24576);
    expect(value.outputLines).toBe(800);
  });

  test("matches DEFAULTS when given empty shipped and no overrides", () => {
    const value = new Config({}, []).value;

    expect(value).toEqual(DEFAULTS);
  });
});

describe("deepMerge precedence", () => {
  test("project overrides global overrides shipped overrides defaults", () => {
    const global = { widgetLimit: 3, sandbox: { mode: "strict" } };
    const project = { widgetLimit: 9, sandbox: { network: "none" } };
    const value = new Config(shipped, [global, project]).value;

    expect(value.widgetLimit).toBe(9);
    expect(value.sandbox.mode).toBe("strict");
    expect(value.sandbox.network).toBe("none");
  });

  test("nested objects merge rather than replace", () => {
    const merged = Config.deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3 } });

    expect(merged).toEqual({ a: { x: 1, y: 3 } });
  });

  test("arrays replace wholesale", () => {
    const merged = Config.deepMerge({ a: [1, 2] }, { a: [3] });

    expect(merged).toEqual({ a: [3] });
  });
});

describe("sanitize fallbacks per bad type", () => {
  test("non-string shell falls back", () => {
    expect(new Config({ shell: 5 }, []).value.shell).toBe("");
  });

  test("non-boolean widget falls back", () => {
    expect(new Config({ widget: "yes" }, []).value.widget).toBe(true);
  });

  test("non-positive widgetLimit falls back, positive floored", () => {
    expect(new Config({ widgetLimit: 0 }, []).value.widgetLimit).toBe(6);
    expect(new Config({ widgetLimit: -2 }, []).value.widgetLimit).toBe(6);
    expect(new Config({ widgetLimit: 4.9 }, []).value.widgetLimit).toBe(4);
  });

  test("invalid sandbox mode and network fall back", () => {
    const value = new Config({ sandbox: { mode: "wild", network: "lan" } }, []).value;

    expect(value.sandbox.mode).toBe("loose");
    expect(value.sandbox.network).toBe("full");
  });

  test("writePaths keeps only non-empty strings", () => {
    const value = new Config({ sandbox: { writePaths: ["/a", "", "  ", 7, "/b"] } }, []).value;

    expect(value.sandbox.writePaths).toEqual(["/a", "/b"]);
  });

  test("non-array writePaths falls back to empty", () => {
    expect(new Config({ sandbox: { writePaths: "/a" } }, []).value.sandbox.writePaths).toEqual([]);
  });

  test("autoBackgroundMs allows 0, rejects negative", () => {
    expect(new Config({ jobs: { autoBackgroundMs: 0 } }, []).value.jobs.autoBackgroundMs).toBe(0);
    expect(new Config({ jobs: { autoBackgroundMs: -1 } }, []).value.jobs.autoBackgroundMs).toBe(30000);
  });

  test("capBytes and defaultWaitSec require positive", () => {
    expect(new Config({ jobs: { capBytes: 0 } }, []).value.jobs.capBytes).toBe(2097152);
    expect(new Config({ jobs: { defaultWaitSec: -3 } }, []).value.jobs.defaultWaitSec).toBe(30);
  });

  test("keepFinished allows 0", () => {
    expect(new Config({ jobs: { keepFinished: 0 } }, []).value.jobs.keepFinished).toBe(0);
  });

  test("non-object sandbox/jobs sections fall back to defaults", () => {
    const value = new Config({ sandbox: 7, jobs: "x" }, []).value;

    expect(value.sandbox).toEqual(DEFAULTS.sandbox);
    expect(value.jobs).toEqual(DEFAULTS.jobs);
  });
});

describe("posInt and nonNegInt", () => {
  test("posInt rejects zero, NaN, Infinity, non-number", () => {
    expect(Config.posInt(0, 9)).toBe(9);
    expect(Config.posInt(Number.NaN, 9)).toBe(9);
    expect(Config.posInt(Number.POSITIVE_INFINITY, 9)).toBe(9);
    expect(Config.posInt("5", 9)).toBe(9);
    expect(Config.posInt(5.7, 9)).toBe(5);
  });

  test("nonNegInt accepts zero", () => {
    expect(Config.nonNegInt(0, 9)).toBe(0);
    expect(Config.nonNegInt(-1, 9)).toBe(9);
    expect(Config.nonNegInt(3.9, 9)).toBe(3);
  });
});

describe("named caps", () => {
  test("expose timeout and wait caps and peek defaults", () => {
    expect(Config.maxTimeoutSec).toBe(86400);
    expect(Config.maxWaitSec).toBe(600);
    expect(Config.toolPeekLines).toBe(50);
    expect(Config.commandPeekLines).toBe(15);
  });
});
