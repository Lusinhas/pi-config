import { describe, expect, test } from "bun:test";
import {
  SEGMENT_IDS,
  SegmentState,
  computeSegments,
  type SegmentId,
  type SegmentInputs,
  type SegmentToggle
} from "../../src/status/index.ts";
import { GitWatcher, type GitExec } from "../../src/status/git.ts";
import { formatCost, formatTokens } from "../../src/status/format.ts";

function allEnabled(): Record<SegmentId, SegmentToggle> {
  const out = {} as Record<SegmentId, SegmentToggle>;

  for (const id of SEGMENT_IDS) {
    out[id] = { enabled: true };
  }

  return out;
}

function inputs(partial: Partial<SegmentInputs>): SegmentInputs {
  return {
    modelId: null,
    contextPercent: null,
    cwd: "/tmp/project",
    git: null,
    state: new SegmentState(),
    warnPercent: 80,
    errorPercent: 95,
    now: new Date(2026, 0, 1, 9, 5, 0),
    ...partial
  };
}

describe("SegmentState defensive parsers", () => {
  test("applyMode requires non-empty trimmed string", () => {
    const s = new SegmentState();

    s.applyMode({ mode: "  build  " });
    expect(s.mode).toBe("build");

    s.applyMode({ mode: "   " });
    expect(s.mode).toBe("build");

    s.applyMode({ mode: 5 });
    expect(s.mode).toBe("build");

    s.applyMode(null);
    expect(s.mode).toBe("build");

    s.applyMode([1, 2]);
    expect(s.mode).toBe("build");
  });

  test("applyRole only updates on non-empty string", () => {
    const s = new SegmentState();

    s.applyRole({ role: "reviewer" });
    expect(s.role).toBe("reviewer");

    s.applyRole({ role: "" });
    expect(s.role).toBe("reviewer");

    s.applyRole({ other: "x" });
    expect(s.role).toBe("reviewer");
  });

  test("applyUsage ignores when both input and output missing", () => {
    const s = new SegmentState();

    s.applyUsage({ cost: 1.23 });
    expect(s.usage).toBeNull();

    s.applyUsage({ input: 100 });
    expect(s.usage).toEqual({ input: 100, output: 0, cost: null });

    s.applyUsage({ input: -5, output: 200, cost: 2.5 });
    expect(s.usage).toEqual({ input: 0, output: 200, cost: 2.5 });

    s.applyUsage({ input: 1, output: 2, cost: "no" });
    expect(s.usage).toEqual({ input: 1, output: 2, cost: null });
  });

  test("applyUsage ignores non-object payloads", () => {
    const s = new SegmentState();

    s.applyUsage("nope");
    s.applyUsage(42);
    s.applyUsage(null);
    expect(s.usage).toBeNull();
  });

  test("applyTodos floors non-negative open and ignores rest", () => {
    const s = new SegmentState();

    s.applyTodos({ open: 3.9 });
    expect(s.todosOpen).toBe(3);

    s.applyTodos({ open: -1 });
    expect(s.todosOpen).toBe(3);

    s.applyTodos({ open: 0 });
    expect(s.todosOpen).toBe(0);

    s.applyTodos({ done: 9 });
    expect(s.todosOpen).toBe(0);
  });
});

describe("SegmentState revision tracking", () => {
  test("bumps only when a value actually changes", () => {
    const s = new SegmentState();

    expect(s.revision).toBe(0);

    s.applyMode({ mode: "build" });
    expect(s.revision).toBe(1);

    s.applyMode({ mode: "build" });
    expect(s.revision).toBe(1);

    s.applyTodos({ open: 2 });
    expect(s.revision).toBe(2);

    s.applyTodos({ open: 2 });
    expect(s.revision).toBe(2);

    s.applyUsage({ input: 10, output: 5, cost: null });
    expect(s.revision).toBe(3);

    s.applyUsage({ input: 10, output: 5, cost: null });
    expect(s.revision).toBe(3);
  });
});

describe("SegmentState.applyIde", () => {
  test("clear:true resets ide to null", () => {
    const s = new SegmentState();

    s.applyIde({ connected: true, activeFile: "/a/b.ts" });
    expect(s.ide).not.toBeNull();

    s.applyIde({ clear: true });
    expect(s.ide).toBeNull();
  });

  test("builds IdeInfo with strict connected and floored positive lines", () => {
    const s = new SegmentState();

    s.applyIde({ connected: true, activeFile: "  /a/main.ts  ", selectedLines: 12.9 });
    expect(s.ide).toEqual({ connected: true, activeFile: "/a/main.ts", selectedLines: 12 });

    s.applyIde({ connected: false, activeFile: "", selectedLines: -4 });
    expect(s.ide).toEqual({ connected: false, activeFile: null, selectedLines: 0 });

    s.applyIde({ connected: "maybe", selectedLines: "x" });
    expect(s.ide).toEqual({ connected: null, activeFile: null, selectedLines: 0 });
  });

  test("ignores non-object payloads", () => {
    const s = new SegmentState();

    s.applyIde("nope");
    s.applyIde(null);
    expect(s.ide).toBeNull();
  });
});

describe("formatTokens", () => {
  test("non-positive and non-finite become 0", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-10)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });

  test("rounds and scales with k/M/B and trims .0", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(99999)).toBe("100k");
    expect(formatTokens(1000000)).toBe("1M");
    expect(formatTokens(2500000)).toBe("2.5M");
    expect(formatTokens(1000000000)).toBe("1B");
    expect(formatTokens(3200000000)).toBe("3.2B");
  });

  test("trimmed uses fixed-0 at or above 100", () => {
    expect(formatTokens(123000)).toBe("123k");
    expect(formatTokens(123400)).toBe("123k");
  });
});

describe("formatCost", () => {
  test("guards invalid and tiers by magnitude", () => {
    expect(formatCost(Number.NaN)).toBe("0.00");
    expect(formatCost(-1)).toBe("0.00");
    expect(formatCost(0)).toBe("0.00");
    expect(formatCost(1.234)).toBe("1.23");
    expect(formatCost(10.55)).toBe("10.6");
    expect(formatCost(125.9)).toBe("126");
  });
});

describe("computeSegments rendering", () => {
  test("model uses accent token, others null", () => {
    const parts = computeSegments(["model"], allEnabled(), inputs({ modelId: "gpt-x" }));

    expect(parts).toEqual([{ id: "model", text: "gpt-x", token: "accent" }]);
  });

  test("git renders branch with dirty marker and state color", () => {
    const clean = computeSegments(["git"], allEnabled(), inputs({ git: { branch: "main", dirty: false } }));
    const dirty = computeSegments(["git"], allEnabled(), inputs({ git: { branch: "main", dirty: true } }));

    expect(clean[0]).toEqual({ id: "git", text: "⎇ main", token: "success" });
    expect(dirty[0]).toEqual({ id: "git", text: "⎇ main*", token: "warning" });
  });

  test("context token thresholds use raw pct but clamp display", () => {
    const warn = computeSegments(["context"], allEnabled(), inputs({ contextPercent: 81 }));
    const err = computeSegments(["context"], allEnabled(), inputs({ contextPercent: 96 }));
    const ok = computeSegments(["context"], allEnabled(), inputs({ contextPercent: 50 }));
    const over = computeSegments(["context"], allEnabled(), inputs({ contextPercent: 1500 }));

    expect(warn[0]).toEqual({ id: "context", text: "ctx 81%", token: "warning" });
    expect(err[0]).toEqual({ id: "context", text: "ctx 96%", token: "error" });
    expect(ok[0]).toEqual({ id: "context", text: "ctx 50%", token: "dim" });
    expect(over[0]).toEqual({ id: "context", text: "ctx 999%", token: "error" });
  });

  test("ide token and text reflect connection, selection and file", () => {
    const connected = new SegmentState();

    connected.applyIde({ connected: true, activeFile: "/a/main.ts" });
    expect(computeSegments(["ide"], allEnabled(), inputs({ state: connected }))[0]).toEqual({
      id: "ide",
      text: "IDE ● main.ts",
      token: "accent"
    });

    const disconnected = new SegmentState();

    disconnected.applyIde({ connected: false });
    expect(computeSegments(["ide"], allEnabled(), inputs({ state: disconnected }))[0]).toEqual({
      id: "ide",
      text: "IDE ○ disconnected",
      token: "error"
    });

    const selection = new SegmentState();

    selection.applyIde({ connected: true, activeFile: "/a/main.ts", selectedLines: 5 });
    expect(computeSegments(["ide"], allEnabled(), inputs({ state: selection }))[0].text).toBe("IDE ● ✂ 5L");

    const unknown = new SegmentState();

    unknown.applyIde({ connected: null });
    expect(computeSegments(["ide"], allEnabled(), inputs({ state: unknown }))[0]).toEqual({
      id: "ide",
      text: "IDE ◌",
      token: "dim"
    });
  });

  test("ide segment is null when no ide state", () => {
    expect(computeSegments(["ide"], allEnabled(), inputs({}))).toEqual([]);
  });

  test("usage with and without cost", () => {
    const s1 = new SegmentState();

    s1.applyUsage({ input: 1500, output: 800, cost: 0.5 });
    const withCost = computeSegments(["usage"], allEnabled(), inputs({ state: s1 }));

    expect(withCost[0]).toEqual({ id: "usage", text: "↑1.5k ↓800 $0.50", token: "dim" });

    const s2 = new SegmentState();

    s2.applyUsage({ input: 10, output: 20, cost: "x" });
    const noCost = computeSegments(["usage"], allEnabled(), inputs({ state: s2 }));

    expect(noCost[0]).toEqual({ id: "usage", text: "↑10 ↓20", token: "dim" });
  });

  test("todos only renders when open > 0", () => {
    const zero = new SegmentState();

    zero.applyTodos({ open: 0 });
    expect(computeSegments(["todos"], allEnabled(), inputs({ state: zero }))).toEqual([]);

    const some = new SegmentState();

    some.applyTodos({ open: 4 });
    expect(computeSegments(["todos"], allEnabled(), inputs({ state: some }))[0]).toEqual({
      id: "todos",
      text: "todos 4",
      token: "muted"
    });
  });

  test("cwd uses basename or full path when basename empty", () => {
    const named = computeSegments(["cwd"], allEnabled(), inputs({ cwd: "/a/b/project" }));
    const root = computeSegments(["cwd"], allEnabled(), inputs({ cwd: "/" }));

    expect(named[0]).toEqual({ id: "cwd", text: "project", token: "muted" });
    expect(root[0]).toEqual({ id: "cwd", text: "/", token: "muted" });
  });

  test("clock zero pads hours and minutes", () => {
    const parts = computeSegments(["clock"], allEnabled(), inputs({ now: new Date(2026, 0, 1, 9, 5, 0) }));

    expect(parts[0]).toEqual({ id: "clock", text: "09:05", token: "dim" });
  });

  test("disabled toggles and null parts are skipped, order honored", () => {
    const toggles = allEnabled();

    toggles.clock = { enabled: false };

    const parts = computeSegments(
      ["clock", "model", "todos", "cwd"],
      toggles,
      inputs({ modelId: "m", cwd: "/x/y" })
    );

    expect(parts.map(p => p.id)).toEqual(["model", "cwd"]);
  });
});

class FakeGit {
  calls: string[][] = [];
  #responses: Map<string, { stdout: string; code: number }>;

  constructor(responses: Record<string, { stdout: string; code: number }>) {
    this.#responses = new Map(Object.entries(responses));
  }

  exec: GitExec = async (_command, args) => {
    this.calls.push(args);
    const key = args.join(" ");
    const found = this.#responses.get(key);

    return found ?? { stdout: "", code: 1 };
  };
}

describe("GitWatcher", () => {
  test("resolves branch and dirty, fires onChange on change only", async () => {
    const git = new FakeGit({
      "-C /repo rev-parse --abbrev-ref HEAD": { stdout: "main\n", code: 0 },
      "-C /repo status --porcelain": { stdout: " M file\n", code: 0 }
    });
    const watcher = new GitWatcher(git.exec, 5000, 3000);
    let changes = 0;

    watcher.poll("/repo", () => {
      changes += 1;
    });
    await Bun.sleep(5);

    expect(watcher.current()).toEqual({ branch: "main", dirty: true });
    expect(changes).toBe(1);

    watcher.poll("/repo", () => {
      changes += 1;
    });
    await Bun.sleep(5);
    expect(changes).toBe(1);
  });

  test("throttles within interval for same cwd", async () => {
    const git = new FakeGit({
      "-C /repo rev-parse --abbrev-ref HEAD": { stdout: "main\n", code: 0 },
      "-C /repo status --porcelain": { stdout: "", code: 0 }
    });
    const watcher = new GitWatcher(git.exec, 100000, 3000);

    watcher.poll("/repo", () => {});
    await Bun.sleep(5);
    const after = git.calls.length;

    watcher.poll("/repo", () => {});
    await Bun.sleep(5);

    expect(git.calls.length).toBe(after);
  });

  test("detached HEAD shows short sha", async () => {
    const git = new FakeGit({
      "-C /repo rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n", code: 0 },
      "-C /repo rev-parse --short HEAD": { stdout: "abc1234\n", code: 0 },
      "-C /repo status --porcelain": { stdout: "", code: 0 }
    });
    const watcher = new GitWatcher(git.exec, 5000, 3000);

    watcher.poll("/repo", () => {});
    await Bun.sleep(5);

    expect(watcher.current()).toEqual({ branch: "@abc1234", dirty: false });
  });

  test("detached HEAD without sha falls back to @detached", async () => {
    const git = new FakeGit({
      "-C /repo rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n", code: 0 },
      "-C /repo rev-parse --short HEAD": { stdout: "", code: 1 },
      "-C /repo status --porcelain": { stdout: "", code: 0 }
    });
    const watcher = new GitWatcher(git.exec, 5000, 3000);

    watcher.poll("/repo", () => {});
    await Bun.sleep(5);

    expect(watcher.current()).toEqual({ branch: "@detached", dirty: false });
  });

  test("non-zero rev-parse yields null", async () => {
    const git = new FakeGit({});
    const watcher = new GitWatcher(git.exec, 5000, 3000);

    watcher.poll("/notrepo", () => {});
    await Bun.sleep(5);

    expect(watcher.current()).toBeNull();
  });

  test("in-flight guard prevents overlap", () => {
    let resolve: ((value: { stdout: string; code: number }) => void) | null = null;
    const exec: GitExec = () =>
      new Promise(r => {
        resolve = r;
      });
    const watcher = new GitWatcher(exec, 5000, 3000);

    watcher.poll("/repo", () => {});
    watcher.poll("/repo", () => {});
    watcher.poll("/repo", () => {});

    expect(resolve).not.toBeNull();
  });

  test("different cwd bypasses throttle", async () => {
    const git = new FakeGit({
      "-C /a rev-parse --abbrev-ref HEAD": { stdout: "main\n", code: 0 },
      "-C /a status --porcelain": { stdout: "", code: 0 },
      "-C /b rev-parse --abbrev-ref HEAD": { stdout: "dev\n", code: 0 },
      "-C /b status --porcelain": { stdout: "", code: 0 }
    });
    const watcher = new GitWatcher(git.exec, 100000, 3000);

    watcher.poll("/a", () => {});
    await Bun.sleep(5);
    watcher.poll("/b", () => {});
    await Bun.sleep(5);

    expect(watcher.current()).toEqual({ branch: "dev", dirty: false });
  });
});
