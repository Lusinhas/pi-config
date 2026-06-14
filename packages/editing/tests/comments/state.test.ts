import { describe, expect, test } from "bun:test";
import type { CheckResult } from "../../src/comments/index.ts";
import { HISTORY_LIMIT, SessionState, type SessionEntry } from "../../src/comments/state.ts";

function result(path: string): CheckResult {
  return { path, tool: "write", findings: [{ rule: "todo", line: 1, text: "// TODO", message: "x" }] };
}

describe("HISTORY_LIMIT", () => {
  test("is 5", () => {
    expect(HISTORY_LIMIT).toBe(5);
  });
});

describe("recordResult", () => {
  test("newest first, bounded to limit", () => {
    const state = new SessionState("block");

    for (let i = 0; i < 8; i += 1) {
      state.recordResult(result(`/repo/${i}.ts`));
    }

    expect(state.history).toHaveLength(HISTORY_LIMIT);
    expect(state.history[0].path).toBe("/repo/7.ts");
    expect(state.history[HISTORY_LIMIT - 1].path).toBe("/repo/3.ts");
  });
});

describe("applyMode", () => {
  test("reports changed only when mode differs", () => {
    const state = new SessionState("block");
    expect(state.applyMode("block")).toEqual({ changed: false, mode: "block" });
    expect(state.applyMode("warn")).toEqual({ changed: true, mode: "warn" });
    expect(state.mode).toBe("warn");
  });
});

describe("shouldWarn", () => {
  test("dedupes on identical key, resets on new key", () => {
    const state = new SessionState("warn");
    expect(state.shouldWarn("k1")).toBe(true);
    expect(state.shouldWarn("k1")).toBe(false);
    expect(state.shouldWarn("k2")).toBe(true);
  });
});

describe("resolveMode", () => {
  test("returns the last matching entry mode", () => {
    const state = new SessionState("block");
    const entries: SessionEntry[] = [
      { type: "custom", customType: "piconfig:comments", data: { mode: "warn" } },
      { type: "custom", customType: "other", data: { mode: "off" } },
      { type: "custom", customType: "piconfig:comments", data: { mode: "off" } },
    ];
    expect(state.resolveMode(entries)).toBe("off");
  });

  test("default mode when no matching entries", () => {
    const state = new SessionState("warn");
    expect(state.resolveMode([{ type: "custom", customType: "other", data: {} }])).toBe("warn");
  });

  test("ignores malformed data", () => {
    const state = new SessionState("block");
    const entries: SessionEntry[] = [
      { type: "custom", customType: "piconfig:comments", data: { mode: "loud" } },
      { type: "custom", customType: "piconfig:comments", data: null },
    ];
    expect(state.resolveMode(entries)).toBe("block");
  });
});

describe("restore", () => {
  test("resets history and warn key, sets resolved mode", () => {
    const state = new SessionState("block");
    state.recordResult(result("/repo/a.ts"));
    state.lastWarnKey = "stale";

    const resolution = state.restore(() => [
      { type: "custom", customType: "piconfig:comments", data: { mode: "off" } },
    ]);

    expect(resolution.mode).toBe("off");
    expect(resolution.error).toBeUndefined();
    expect(state.history).toEqual([]);
    expect(state.lastWarnKey).toBe("");
    expect(state.mode).toBe("off");
  });

  test("read failure falls back to default and surfaces the error", () => {
    const state = new SessionState("warn");

    const resolution = state.restore(() => {
      throw new Error("disk gone");
    });

    expect(resolution.mode).toBe("warn");
    expect(resolution.error).toBeInstanceOf(Error);
    expect(resolution.error?.message).toBe("disk gone");
    expect(state.mode).toBe("warn");
  });
});
