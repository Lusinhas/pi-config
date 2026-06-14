import { describe, expect, it } from "bun:test";
import { Interval, LoopRunner } from "../../src/goals/loop.ts";
import type { LoopHooks, LoopSpec } from "../../src/goals/loop.ts";

describe("Interval.parse", () => {
  it("treats bare digits as seconds with a normalized label", () => {
    expect(Interval.parse("90")).toEqual({ ms: 90000, label: "90s" });
    expect(Interval.parse("1")).toEqual({ ms: 1000, label: "1s" });
  });

  it("rejects a bare zero", () => {
    expect(Interval.parse("0")).toBeUndefined();
  });

  it("parses single-unit tokens", () => {
    expect(Interval.parse("30s")).toEqual({ ms: 30000, label: "30s" });
    expect(Interval.parse("5m")).toEqual({ ms: 300000, label: "5m" });
    expect(Interval.parse("1h")).toEqual({ ms: 3600000, label: "1h" });
    expect(Interval.parse("250ms")).toEqual({ ms: 250, label: "250ms" });
  });

  it("parses contiguous concatenated unit groups and keeps the raw lowercased label", () => {
    expect(Interval.parse("1h30m")).toEqual({ ms: 5400000, label: "1h30m" });
    expect(Interval.parse("1H30M")).toEqual({ ms: 5400000, label: "1h30m" });
  });

  it("rounds fractional totals", () => {
    expect(Interval.parse("1.5s")).toEqual({ ms: 1500, label: "1.5s" });
  });

  it("rejects gaps, leftovers, and empty input", () => {
    expect(Interval.parse("1h x30m")).toBeUndefined();
    expect(Interval.parse("1habc")).toBeUndefined();
    expect(Interval.parse("abc")).toBeUndefined();
    expect(Interval.parse("")).toBeUndefined();
    expect(Interval.parse("   ")).toBeUndefined();
  });

  it("rejects unknown units", () => {
    expect(Interval.parse("5d")).toBeUndefined();
  });
});

describe("Interval.format", () => {
  it("walks the divisibility ladder", () => {
    expect(Interval.format(7200000)).toBe("2h");
    expect(Interval.format(300000)).toBe("5m");
    expect(Interval.format(5000)).toBe("5s");
    expect(Interval.format(5400000)).toBe("90m");
    expect(Interval.format(250)).toBe("250ms");
    expect(Interval.format(1500)).toBe("1500ms");
  });
});

class FakeHooks implements LoopHooks {
  sent: string[] = [];
  persisted: Array<{ active: boolean; spec?: LoopSpec }> = [];
  idle = true;
  throwOnSend = false;

  send(prompt: string): void {

    if (this.throwOnSend) {
      throw new Error("send failed");
    }

    this.sent.push(prompt);
  }

  isIdle(): boolean {
    return this.idle;
  }

  persist(active: boolean, spec?: LoopSpec): void {
    this.persisted.push({ active, spec });
  }
}

function spec(overrides: Partial<LoopSpec> = {}): LoopSpec {
  return { intervalMs: 1000, intervalLabel: "1s", prompt: "go", startedAt: 0, ...overrides };
}

describe("LoopRunner", () => {
  it("starts inactive and exposes counters", () => {
    const runner = new LoopRunner(new FakeHooks());

    expect(runner.active).toBe(false);
    expect(runner.spec).toBeUndefined();
    expect(runner.ticks).toBe(0);
    expect(runner.skipped).toBe(0);
  });

  it("persists on start only when asked and resets counters", () => {
    const hooks = new FakeHooks();
    const runner = new LoopRunner(hooks);
    runner.start(spec(), true);

    expect(runner.active).toBe(true);
    expect(hooks.persisted).toEqual([{ active: true, spec: spec() }]);

    runner.start(spec({ prompt: "again" }), false);

    expect(hooks.persisted.length).toBe(1);
    expect(runner.spec?.prompt).toBe("again");

    runner.stop(false);
  });

  it("sends and counts a tick while idle", () => {
    const hooks = new FakeHooks();
    const runner = new LoopRunner(hooks);
    runner.start(spec(), false);
    runner.tick();

    expect(hooks.sent).toEqual(["go"]);
    expect(runner.ticks).toBe(1);
    expect(runner.skipped).toBe(0);

    runner.stop(false);
  });

  it("skips a tick while busy", () => {
    const hooks = new FakeHooks();
    hooks.idle = false;
    const runner = new LoopRunner(hooks);
    runner.start(spec(), false);
    runner.tick();

    expect(hooks.sent).toEqual([]);
    expect(runner.skipped).toBe(1);
    expect(runner.ticks).toBe(0);

    runner.stop(false);
  });

  it("counts a skip when send throws but still treats it as a tick attempt", () => {
    const hooks = new FakeHooks();
    hooks.throwOnSend = true;
    const runner = new LoopRunner(hooks);
    runner.start(spec(), false);
    runner.tick();

    expect(runner.ticks).toBe(1);
    expect(runner.skipped).toBe(1);

    runner.stop(false);
  });

  it("treats an isIdle throw as busy", () => {
    const hooks = new FakeHooks();
    hooks.isIdle = () => {
      throw new Error("ctx gone");
    };
    const runner = new LoopRunner(hooks);
    runner.start(spec(), false);
    runner.tick();

    expect(runner.skipped).toBe(1);

    runner.stop(false);
  });

  it("ignores ticks after stop", () => {
    const hooks = new FakeHooks();
    const runner = new LoopRunner(hooks);
    runner.start(spec(), false);
    runner.stop(false);
    runner.tick();

    expect(hooks.sent).toEqual([]);
  });

  it("persists inactive on stop only when active and asked", () => {
    const hooks = new FakeHooks();
    const runner = new LoopRunner(hooks);
    runner.stop(true);

    expect(hooks.persisted).toEqual([]);

    runner.start(spec(), false);
    runner.stop(true);

    expect(hooks.persisted).toEqual([{ active: false, spec: undefined }]);
  });
});
