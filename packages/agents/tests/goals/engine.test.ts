import { describe, expect, it } from "bun:test";
import { Config } from "../../src/goals/config.ts";
import { GoalEngine } from "../../src/goals/index.ts";
import type { EnginePorts, NotifyLevel } from "../../src/goals/index.ts";
import { Judge } from "../../src/goals/judge.ts";
import type { CompleteResponse, JudgeRegistry } from "../../src/goals/judge.ts";
import { LoopRunner } from "../../src/goals/loop.ts";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface Sent {
  prompt: string;
  options?: { deliverAs: "followUp" };
}

interface Entry {
  customType: string;
  data: Record<string, unknown>;
}

class FakePorts implements EnginePorts {
  notes: Array<{ message: string; level: NotifyLevel }> = [];
  statuses: Array<string | undefined> = [];
  sent: Sent[] = [];
  appended: Entry[] = [];
  entryList: unknown[] = [];
  reg: JudgeRegistry = { find: () => ({ id: "m" }) };

  notify(message: string, level: NotifyLevel): void {
    this.notes.push({ message, level });
  }

  setStatus(text: string | undefined): void {
    this.statuses.push(text);
  }

  sendUserMessage(prompt: string, options?: { deliverAs: "followUp" }): void {
    this.sent.push({ prompt, options });
  }

  appendEntry(customType: string, data: Record<string, unknown>): void {
    this.appended.push({ customType, data });
  }

  registry(): JudgeRegistry {
    return this.reg;
  }

  entries(): readonly unknown[] {
    return this.entryList;
  }

  get lastStatus(): string | undefined {
    return this.statuses[this.statuses.length - 1];
  }
}

function build(reply: string | CompleteResponse, overrides: Partial<Record<string, unknown>> = {}) {
  const config = new Config([overrides]).values;
  const ports = new FakePorts();
  const response: CompleteResponse = typeof reply === "string" ? { content: reply, stopReason: "stop" } : reply;
  const judge = new Judge(async () => response);
  const loop = new LoopRunner({
    send: (prompt: string) => ports.sendUserMessage(prompt),
    isIdle: () => true,
    persist: (active, spec) => {
      ports.appendEntry("goals:loop", active && spec ? { active: true, ...spec } : { active: false });
    },
  });
  const engine = new GoalEngine(config, judge, loop, ports);

  return { engine, ports, loop, config };
}

describe("GoalEngine goal command", () => {
  it("shows status on empty args and on status keyword", () => {
    const { engine, ports } = build("VERDICT: met\nREASON: ok");
    engine.handleGoal("");

    expect(ports.notes[0]).toEqual({ message: "No active goal.\nNo active loop.", level: "info" });

    engine.handleGoal("STATUS");

    expect(ports.notes[1].message).toBe("No active goal.\nNo active loop.");
  });

  it("arms a goal, persists it, and notifies", () => {
    const { engine, ports } = build("");
    engine.handleGoal("make the tests pass");

    expect(engine.goal?.condition).toBe("make the tests pass");
    expect(engine.goal?.iterations).toBe(0);
    expect(ports.appended[0]).toEqual({
      customType: "goals:goal",
      data: { active: true, condition: "make the tests pass", iterations: 0, startedAt: engine.goal?.startedAt },
    });
    expect(ports.notes[0].message).toBe(
      "Goal armed: make the tests pass\nJudged by anthropic/claude-haiku-4-5 after each agent run, capped at 25 continuations. Use /goal off to stop.",
    );
  });

  it("reports replacement when a goal already existed", () => {
    const { engine, ports } = build("");
    engine.handleGoal("first");
    engine.handleGoal("second");

    expect(ports.notes[1].message.startsWith("Goal replaced: second")).toBe(true);
    expect(engine.goal?.condition).toBe("second");
    expect(engine.goal?.iterations).toBe(0);
  });

  it("clears a goal with off and reports whether one was active", () => {
    const { engine, ports } = build("");
    engine.handleGoal("off");

    expect(ports.notes[0].message).toBe("No active goal.");

    engine.handleGoal("do x");
    engine.handleGoal("off");

    expect(ports.notes[ports.notes.length - 1].message).toBe("Goal cleared.");
    expect(engine.goal).toBeUndefined();
  });
});

describe("GoalEngine loop command", () => {
  it("shows usage when no active loop and when active", () => {
    const { engine, ports } = build("");
    engine.handleLoop("");

    expect(ports.notes[0].message).toBe(`No active loop.\n${GoalEngine.loopUsage}`);

    engine.handleLoop("30s keep going");

    expect(engine.loop.active).toBe(true);
    engine.handleLoop("");

    expect(ports.notes[ports.notes.length - 1].message).toBe(
      `Loop active: every 30s — keep going\n${GoalEngine.loopUsage}`,
    );

    engine.loop.stop(false);
  });

  it("arms a loop and reports the clamp note when below the minimum", () => {
    const { engine, ports } = build("");
    engine.handleLoop("1s tick");

    expect(engine.loop.spec?.intervalMs).toBe(5000);
    expect(engine.loop.spec?.intervalLabel).toBe("5s");
    expect(ports.notes[0].message).toBe(
      "Loop armed: every 5s (raised to the 5s minimum) — tick\nTicks are skipped while the agent is busy. Use /loop off to cancel.",
    );

    engine.loop.stop(false);
  });

  it("arms without clamp note above the minimum and reports replacement", () => {
    const { engine, ports } = build("");
    engine.handleLoop("30s a");
    engine.handleLoop("1m b");

    expect(ports.notes[1].message).toBe(
      "Loop replaced: every 1m — b\nTicks are skipped while the agent is busy. Use /loop off to cancel.",
    );

    engine.loop.stop(false);
  });

  it("rejects missing prompt and invalid interval", () => {
    const { engine, ports } = build("");
    engine.handleLoop("30s");

    expect(ports.notes[0]).toEqual({ message: GoalEngine.loopUsage, level: "error" });

    engine.handleLoop("bad go now");

    expect(ports.notes[1].message).toBe(`Invalid interval "bad". ${GoalEngine.loopUsage}`);

    engine.handleLoop("5m    ");

    expect(ports.notes[2].message).toBe(GoalEngine.loopUsage);
  });

  it("cancels with off and reports whether one was active", () => {
    const { engine, ports } = build("");
    engine.handleLoop("off");

    expect(ports.notes[0].message).toBe("No active loop.");

    engine.handleLoop("30s x");
    engine.handleLoop("off");

    expect(ports.notes[ports.notes.length - 1].message).toBe("Loop cancelled.");
    expect(engine.loop.active).toBe(false);
  });
});

describe("GoalEngine status widget", () => {
  it("is undefined when neither goal nor loop is active", () => {
    const { engine } = build("");

    expect(engine.statusWidget()).toBeUndefined();
  });

  it("collapses whitespace and clips long lines to statusMaxChars with an ellipsis", () => {
    const { engine } = build("", { statusMaxChars: 12 });
    engine.handleGoal("a very long   condition that exceeds the limit");

    expect(engine.statusWidget()).toBe("goal 0/25: a very long…");
  });

  it("joins goal and loop widget parts with two spaces", () => {
    const { engine } = build("");
    engine.handleGoal("ship");
    engine.handleLoop("30s nudge");

    expect(engine.statusWidget()).toBe("goal 0/25: ship  loop 30s: nudge");

    engine.loop.stop(false);
  });
});

describe("GoalEngine statusText", () => {
  it("includes open todo count only when enforcing", () => {
    const { engine } = build("", { enforceTodos: true });
    engine.ingestTodos({ open: 3, items: [] });
    engine.handleGoal("finish");
    const text = engine.statusText();

    expect(text).toContain("Goal: finish");
    expect(text).toContain("Continuations: 0/25");
    expect(text).toContain("Judge model: anthropic/claude-haiku-4-5 (fallback marker: <goal-met/>)");
    expect(text).toContain("Todo enforcement: on");
    expect(text).toContain("Open todos: 3");
  });
});

describe("GoalEngine todo ingestion and labels", () => {
  it("clamps open to a non-negative number and stores items leniently", () => {
    const { engine } = build("");
    engine.ingestTodos({ open: -5, items: [{ text: "x" }] });

    expect(engine.openTodoLabels()).toEqual([]);

    engine.ingestTodos({ open: "bad", items: 42 });

    expect(engine.openTodoLabels()).toEqual([]);
  });

  it("derives labels and skips completed items", () => {
    const { engine } = build("");
    engine.ingestTodos({
      open: 5,
      items: [
        "  raw label  ",
        { done: true, text: "skip" },
        { completed: true, title: "skip" },
        { status: "cancelled", title: "skip" },
        { title: "  trimmed title  " },
        { foo: "bar" },
      ],
    });

    expect(engine.openTodoLabels()).toEqual(["raw label", "trimmed title", JSON.stringify({ foo: "bar" })]);
  });

  it("produces a synthetic label when open is positive but no labels survive", () => {
    const { engine } = build("");
    engine.ingestTodos({ open: 1, items: [{ done: true }] });

    expect(engine.openTodoLabels()).toEqual(["1 open todo"]);

    engine.ingestTodos({ open: 2, items: [{ done: true }] });

    expect(engine.openTodoLabels()).toEqual(["2 open todos"]);
  });

  it("ignores non-record payloads", () => {
    const { engine } = build("");
    engine.ingestTodos(null);
    engine.ingestTodos([1, 2]);

    expect(engine.openTodoLabels()).toEqual([]);
  });
});

describe("GoalEngine judging flow", () => {
  it("does nothing without a goal", async () => {
    const { engine, ports } = build("VERDICT: met\nREASON: ok");
    await engine.judgeAfterAgent([]);

    expect(ports.notes).toEqual([]);
  });

  it("clears the goal and notifies on a met verdict", async () => {
    const { engine, ports } = build("VERDICT: met\nREASON: shipped");
    engine.handleGoal("ship");
    ports.notes = [];
    await engine.judgeAfterAgent([{ role: "assistant", content: "done" }]);

    expect(ports.notes[0]).toEqual({ message: "Goal met: shipped", level: "info" });
    expect(engine.goal).toBeUndefined();
  });

  it("clears the goal and warns on a blocked verdict", async () => {
    const { engine, ports } = build("VERDICT: blocked\nREASON: impossible");
    engine.handleGoal("ship");
    ports.notes = [];
    await engine.judgeAfterAgent([{ role: "assistant", content: "stuck" }]);

    expect(ports.notes[0]).toEqual({ message: "Goal blocked: impossible", level: "warning" });
    expect(engine.goal).toBeUndefined();
  });

  it("sends a continuation nudge and increments iterations on unmet", async () => {
    const { engine, ports } = build("VERDICT: unmet\nREASON: keep going");
    engine.handleGoal("ship");
    ports.sent = [];
    await engine.judgeAfterAgent([{ role: "assistant", content: "wip" }]);

    expect(engine.goal?.iterations).toBe(1);
    expect(ports.sent.length).toBe(1);
    expect(ports.sent[0].options).toEqual({ deliverAs: "followUp" });
    expect(ports.sent[0].prompt).toContain("[goal] The completion condition is not yet met.");
    expect(ports.sent[0].prompt).toContain("Condition: ship");
    expect(ports.sent[0].prompt).toContain("Judge (judge): keep going");
    expect(ports.sent[0].prompt).toContain("Continuation 1/25.");
    expect(ports.sent[0].prompt).toContain("include <goal-met/> in your final message");
  });

  it("stops at the iteration cap with a warning instead of nudging", async () => {
    const { engine, ports } = build("VERDICT: unmet\nREASON: nope", { maxIterations: 2 });
    engine.handleGoal("ship");

    await engine.judgeAfterAgent([{ role: "assistant", content: "a" }]);
    await engine.judgeAfterAgent([{ role: "assistant", content: "b" }]);

    expect(engine.goal?.iterations).toBe(2);

    ports.notes = [];
    ports.sent = [];
    await engine.judgeAfterAgent([{ role: "assistant", content: "c" }]);

    expect(ports.sent).toEqual([]);
    expect(ports.notes[0]).toEqual({
      message: "Goal stopped after 2 continuations without being met: ship",
      level: "warning",
    });
    expect(engine.goal).toBeUndefined();
  });

  it("short-circuits to a todos verdict without calling the judge when enforcing", async () => {
    let judgeCalled = false;
    const config = new Config([{ enforceTodos: true }]).values;
    const ports = new FakePorts();
    const judge = new Judge(async () => {
      judgeCalled = true;

      return { content: "VERDICT: met\nREASON: x", stopReason: "stop" };
    });
    const loop = new LoopRunner({ send: () => {}, isIdle: () => true, persist: () => {} });
    const engine = new GoalEngine(config, judge, loop, ports);
    engine.handleGoal("ship");
    engine.ingestTodos({ open: 2, items: ["one", "two"] });
    ports.sent = [];
    await engine.judgeAfterAgent([{ role: "assistant", content: "wip" }]);

    expect(judgeCalled).toBe(false);
    expect(ports.sent[0].prompt).toContain("Judge (todos): 2 open todos remain");
    expect(ports.sent[0].prompt).toContain("Open todos:");
    expect(ports.sent[0].prompt).toContain("- one");
    expect(ports.sent[0].prompt).toContain("- two");
  });

  it("uses singular phrasing for a single open todo", async () => {
    const config = new Config([{ enforceTodos: true }]).values;
    const ports = new FakePorts();
    const judge = new Judge(async () => ({ content: "", stopReason: "stop" }));
    const loop = new LoopRunner({ send: () => {}, isIdle: () => true, persist: () => {} });
    const engine = new GoalEngine(config, judge, loop, ports);
    engine.handleGoal("ship");
    engine.ingestTodos({ open: 1, items: ["only"] });
    ports.sent = [];
    await engine.judgeAfterAgent([{ role: "assistant", content: "wip" }]);

    expect(ports.sent[0].prompt).toContain("Judge (todos): 1 open todo remains");
  });

  it("truncates the open todo list to twenty entries with a more line", async () => {
    const config = new Config([{ enforceTodos: true }]).values;
    const ports = new FakePorts();
    const judge = new Judge(async () => ({ content: "", stopReason: "stop" }));
    const loop = new LoopRunner({ send: () => {}, isIdle: () => true, persist: () => {} });
    const engine = new GoalEngine(config, judge, loop, ports);
    engine.handleGoal("ship");
    const items = Array.from({ length: 25 }, (_value, index) => `task ${index}`);
    engine.ingestTodos({ open: 25, items });
    ports.sent = [];
    await engine.judgeAfterAgent([{ role: "assistant", content: "wip" }]);

    expect(ports.sent[0].prompt).toContain("- task 19");
    expect(ports.sent[0].prompt).not.toContain("- task 20");
    expect(ports.sent[0].prompt).toContain("- …and 5 more");
  });

  it("ignores a stale verdict when the goal was replaced mid-judge", async () => {
    const config = new Config([]).values;
    const ports = new FakePorts();
    let resolveJudge: ((value: CompleteResponse) => void) | undefined;
    const judge = new Judge(
      () =>
        new Promise<CompleteResponse>(resolve => {
          resolveJudge = resolve;
        }),
    );
    const loop = new LoopRunner({ send: () => {}, isIdle: () => true, persist: () => {} });
    const engine = new GoalEngine(config, judge, loop, ports);
    engine.handleGoal("first");
    const pending = engine.judgeAfterAgent([{ role: "assistant", content: "wip" }]);
    await flush();
    engine.handleGoal("second");
    resolveJudge?.({ content: "VERDICT: met\nREASON: x", stopReason: "stop" });
    await pending;

    expect(engine.goal?.condition).toBe("second");
    expect(ports.notes.some(note => note.message.startsWith("Goal met"))).toBe(false);
  });

  it("is single-flight while a judge call is in progress", async () => {
    const config = new Config([]).values;
    const ports = new FakePorts();
    let calls = 0;
    let resolveJudge: ((value: CompleteResponse) => void) | undefined;
    const judge = new Judge(() => {
      calls += 1;

      return new Promise<CompleteResponse>(resolve => {
        resolveJudge = resolve;
      });
    });
    const loop = new LoopRunner({ send: () => {}, isIdle: () => true, persist: () => {} });
    const engine = new GoalEngine(config, judge, loop, ports);
    engine.handleGoal("ship");
    const first = engine.judgeAfterAgent([{ role: "assistant", content: "a" }]);
    await flush();
    await engine.judgeAfterAgent([{ role: "assistant", content: "b" }]);

    expect(calls).toBe(1);

    resolveJudge?.({ content: "VERDICT: unmet\nREASON: go", stopReason: "stop" });
    await first;
  });
});

describe("GoalEngine restore", () => {
  it("restores the last goal and loop entries and clamps the interval", () => {
    const { engine, ports } = build("");
    ports.entryList = [
      { type: "custom", customType: "goals:goal", data: { active: true, condition: "old", iterations: 1 } },
      { type: "custom", customType: "goals:goal", data: { active: true, condition: "newest", iterations: 4.9, startedAt: 10 } },
      { type: "custom", customType: "goals:loop", data: { active: true, prompt: "ping", intervalMs: 1000 } },
    ];
    engine.restore();

    expect(engine.goal).toEqual({ condition: "newest", iterations: 4, startedAt: 10 });
    expect(engine.loop.spec?.intervalMs).toBe(5000);
    expect(engine.loop.spec?.intervalLabel).toBe("5s");
    expect(engine.loop.spec?.prompt).toBe("ping");

    engine.loop.stop(false);
  });

  it("does not restore an inactive or invalid goal entry", () => {
    const { engine, ports } = build("");
    ports.entryList = [
      { type: "custom", customType: "goals:goal", data: { active: false } },
      { type: "custom", customType: "goals:goal", data: { active: true, condition: "   " } },
    ];
    engine.restore();

    expect(engine.goal).toBeUndefined();
  });

  it("keeps a stored interval label and falls back when missing", () => {
    const { engine, ports } = build("");
    ports.entryList = [
      {
        type: "custom",
        customType: "goals:loop",
        data: { active: true, prompt: "p", intervalMs: 60000, intervalLabel: "custom" },
      },
    ];
    engine.restore();

    expect(engine.loop.spec?.intervalLabel).toBe("custom");

    ports.entryList = [
      { type: "custom", customType: "goals:loop", data: { active: true, prompt: "p", intervalMs: 60000 } },
    ];
    engine.restore();

    expect(engine.loop.spec?.intervalLabel).toBe("1m");

    engine.loop.stop(false);
  });

  it("ignores invalid loop entries", () => {
    const { engine, ports } = build("");
    ports.entryList = [
      { type: "custom", customType: "goals:loop", data: { active: true, prompt: "", intervalMs: 60000 } },
      { type: "custom", customType: "goals:loop", data: { active: true, prompt: "p", intervalMs: -1 } },
    ];
    engine.restore();

    expect(engine.loop.active).toBe(false);
  });

  it("survives a throwing entries source", () => {
    const { engine, ports } = build("");
    ports.entries = () => {
      throw new Error("no session");
    };
    engine.restore();

    expect(engine.goal).toBeUndefined();
    expect(engine.loop.active).toBe(false);
  });
});
