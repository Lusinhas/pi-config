import { describe, expect, test } from "bun:test";
import { Config, type PlanConfig } from "../../src/plan/settings.ts";
import { Gating, type GatingHost } from "../../src/plan/index.ts";
import { Store } from "../../src/plan/store.ts";

function config(over: Partial<PlanConfig> = {}): PlanConfig {
  return { ...Config.DEFAULTS, ...over };
}

interface UiCall {
  active: boolean;
  gated: string[];
}

class FakeHost implements GatingHost {
  all: string[];
  activeTools: string[];
  entries: unknown[] = [];

  readonly setCalls: string[][] = [];
  readonly stateEntries: Array<{ snapshot: string[]; gated: string[]; active: boolean }> = [];
  readonly uiCalls: UiCall[] = [];

  constructor(all: string[], activeTools: string[]) {
    this.all = all;
    this.activeTools = activeTools;
  }

  allToolNames(): string[] {
    return [...this.all];
  }

  activeToolNames(): string[] {
    return [...this.activeTools];
  }

  setActiveTools(names: string[]): void {
    this.setCalls.push([...names]);
    this.activeTools = [...names];
  }

  appendStateEntry(snapshot: string[], gated: string[], active: boolean): void {
    this.stateEntries.push({ snapshot: [...snapshot], gated: [...gated], active });
    this.entries.push({ type: "custom", customType: Store.STATETYPE, data: { active, snapshot, gated } });
  }

  readEntries(): unknown {
    return this.entries;
  }

  applyUi(active: boolean, gated: string[]): void {
    this.uiCalls.push({ active, gated: [...gated] });
  }
}

describe("Gating.normalizeNames", () => {
  test("returns empty for non-arrays", () => {
    expect(Gating.normalizeNames("x")).toEqual([]);
    expect(Gating.normalizeNames(null)).toEqual([]);
  });

  test("accepts string lists and dedups in order", () => {
    expect(Gating.normalizeNames(["read", "grep", "read", ""])).toEqual(["read", "grep"]);
  });

  test("accepts object lists with name fields", () => {
    expect(Gating.normalizeNames([{ name: "read" }, { name: "" }, { other: 1 }, { name: "grep" }])).toEqual([
      "read",
      "grep",
    ]);
  });

  test("mixes strings and objects, dedups across both", () => {
    expect(Gating.normalizeNames(["read", { name: "read" }, { name: "ls" }])).toEqual(["read", "ls"]);
  });
});

describe("Gating.computeGated", () => {
  test("intersects allowed with existing, dedups, preserves allowed order", () => {
    const allowed = ["read", "grep", "find", "read"];
    const existing = ["grep", "read", "write"];

    expect(Gating.computeGated(allowed, existing)).toEqual(["read", "grep"]);
  });

  test("returns empty when nothing overlaps", () => {
    expect(Gating.computeGated(["read"], ["write"])).toEqual([]);
  });
});

describe("Gating.restoreTarget", () => {
  test("keeps snapshot tools that still exist", () => {
    expect(Gating.restoreTarget(["read", "gone", "ls"], ["read", "ls", "write"])).toEqual(["read", "ls"]);
  });

  test("falls back to all existing tools when none of the snapshot exists", () => {
    expect(Gating.restoreTarget(["gone"], ["read", "write"])).toEqual(["read", "write"]);
  });
});

describe("Gating.enter", () => {
  test("snapshots active tools, gates to read-only set, persists, and applies UI", async () => {
    const host = new FakeHost(["read", "grep", "write", "edit"], ["read", "grep", "write", "edit"]);
    const gating = new Gating(host, config({ readonlyTools: ["read", "grep"], extraAllowed: [] }));

    const entered = await gating.enter(true);

    expect(entered).toBe(true);
    expect(gating.state.active).toBe(true);
    expect(gating.state.snapshot).toEqual(["read", "grep", "write", "edit"]);
    expect(gating.state.gated).toEqual(["read", "grep"]);
    expect(host.setCalls).toEqual([["read", "grep"]]);
    expect(host.stateEntries).toEqual([{ snapshot: ["read", "grep", "write", "edit"], gated: ["read", "grep"], active: true }]);
    expect(host.uiCalls).toEqual([{ active: true, gated: ["read", "grep"] }]);
  });

  test("is a no-op when already active", async () => {
    const host = new FakeHost(["read"], ["read"]);
    const gating = new Gating(host, config());
    await gating.enter(true);
    host.setCalls.length = 0;

    const again = await gating.enter(true);

    expect(again).toBe(false);
    expect(host.setCalls).toEqual([]);
  });

  test("does not persist when persist is false", async () => {
    const host = new FakeHost(["read"], ["read"]);
    const gating = new Gating(host, config());

    await gating.enter(false);

    expect(host.stateEntries).toEqual([]);
  });
});

describe("Gating.exit", () => {
  test("restores the snapshot and clears state", async () => {
    const host = new FakeHost(["read", "grep", "write"], ["read", "grep", "write"]);
    const gating = new Gating(host, config({ readonlyTools: ["read"], extraAllowed: [] }));
    await gating.enter(false);
    host.setCalls.length = 0;
    host.uiCalls.length = 0;

    const exited = await gating.exit(true);

    expect(exited).toBe(true);
    expect(gating.state.active).toBe(false);
    expect(gating.state.snapshot).toEqual([]);
    expect(gating.state.gated).toEqual([]);
    expect(host.setCalls).toEqual([["read", "grep", "write"]]);
    expect(host.uiCalls).toEqual([{ active: false, gated: [] }]);
  });

  test("falls back to all tools when the snapshot no longer exists", async () => {
    const host = new FakeHost(["read", "grep"], ["read"]);
    const gating = new Gating(host, config({ readonlyTools: ["read"], extraAllowed: [] }));
    await gating.enter(false);
    host.all = ["alpha", "beta"];
    host.setCalls.length = 0;

    await gating.exit(false);

    expect(host.setCalls).toEqual([["alpha", "beta"]]);
  });

  test("is a no-op when not active", async () => {
    const host = new FakeHost(["read"], ["read"]);
    const gating = new Gating(host, config());

    const exited = await gating.exit(true);

    expect(exited).toBe(false);
    expect(host.setCalls).toEqual([]);
  });
});

describe("Gating.evaluateToolCall", () => {
  test("returns undefined when inactive", () => {
    const host = new FakeHost(["read"], ["read"]);
    const gating = new Gating(host, config());

    expect(gating.evaluateToolCall("write")).toBeUndefined();
  });

  test("blocks only blocked tool names while active", async () => {
    const host = new FakeHost(["read", "write"], ["read", "write"]);
    const gating = new Gating(host, config({ blockedTools: ["write", "edit"] }));
    await gating.enter(false);

    expect(gating.evaluateToolCall("write")).toEqual({ block: true, reason: config().blockReason });
    expect(gating.evaluateToolCall("edit")).toEqual({ block: true, reason: config().blockReason });
    expect(gating.evaluateToolCall("read")).toBeUndefined();
    expect(gating.evaluateToolCall(42)).toBeUndefined();
  });

  test("does not block a non-blocked tool that is also not gated", async () => {
    const host = new FakeHost(["read", "danger"], ["read", "danger"]);
    const gating = new Gating(host, config({ blockedTools: ["write"], readonlyTools: ["read"], extraAllowed: [] }));
    await gating.enter(false);

    expect(gating.evaluateToolCall("danger")).toBeUndefined();
  });
});

describe("Gating.systemPrompt", () => {
  test("appends to a non-empty string with a blank line", () => {
    const host = new FakeHost([], []);
    const gating = new Gating(host, config({ systemPrompt: "ADD" }));

    expect(gating.systemPrompt("base")).toBe("base\n\nADD");
  });

  test("joins string array parts then appends the addendum", () => {
    const host = new FakeHost([], []);
    const gating = new Gating(host, config({ systemPrompt: "ADD" }));

    expect(gating.systemPrompt(["a", 1, "b"])).toBe("a\n\nb\n\nADD");
  });

  test("returns the addendum alone for empty or blank input", () => {
    const host = new FakeHost([], []);
    const gating = new Gating(host, config({ systemPrompt: "ADD" }));

    expect(gating.systemPrompt("")).toBe("ADD");
    expect(gating.systemPrompt("   ")).toBe("ADD");
    expect(gating.systemPrompt(undefined)).toBe("ADD");
  });
});

describe("Gating.syncFromSession", () => {
  test("restores plan mode from a persisted active entry without re-persisting", async () => {
    const host = new FakeHost(["read", "grep", "write"], ["read", "grep", "write"]);
    host.entries = [
      {
        type: "custom",
        customType: Store.STATETYPE,
        data: { active: true, snapshot: ["read", "grep", "write"], gated: ["read"] },
      },
    ];
    const gating = new Gating(host, config({ readonlyTools: ["read", "grep"], extraAllowed: [] }));

    await gating.syncFromSession();

    expect(gating.state.active).toBe(true);
    expect(gating.state.snapshot).toEqual(["read", "grep", "write"]);
    expect(gating.state.gated).toEqual(["read", "grep"]);
    expect(host.setCalls).toEqual([["read", "grep"]]);
    expect(host.stateEntries).toEqual([]);
    expect(host.uiCalls).toEqual([{ active: true, gated: ["read", "grep"] }]);
  });

  test("derives snapshot from current active tools when persisted snapshot is gone", async () => {
    const host = new FakeHost(["read"], ["read"]);
    host.entries = [
      { type: "custom", customType: Store.STATETYPE, data: { active: true, snapshot: ["vanished"], gated: ["read"] } },
    ];
    const gating = new Gating(host, config({ readonlyTools: ["read"], extraAllowed: [] }));

    await gating.syncFromSession();

    expect(gating.state.snapshot).toEqual(["read"]);
  });

  test("exits plan mode when no active entry but state was active", async () => {
    const host = new FakeHost(["read", "write"], ["read", "write"]);
    const gating = new Gating(host, config({ readonlyTools: ["read"], extraAllowed: [] }));
    await gating.enter(false);
    host.entries = [];
    host.setCalls.length = 0;

    await gating.syncFromSession();

    expect(gating.state.active).toBe(false);
    expect(host.setCalls).toEqual([["read", "write"]]);
  });

  test("only resets reviewing and applies UI when nothing is active", async () => {
    const host = new FakeHost(["read"], ["read"]);
    const gating = new Gating(host, config());
    gating.state.reviewing = true;

    await gating.syncFromSession();

    expect(gating.state.active).toBe(false);
    expect(gating.state.reviewing).toBe(false);
    expect(host.setCalls).toEqual([]);
    expect(host.uiCalls).toEqual([{ active: false, gated: [] }]);
  });
});
