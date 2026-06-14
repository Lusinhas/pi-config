import { describe, expect, test } from "bun:test"
import {
  Dispatcher,
  History,
  basePayload,
  type DispatchOptions,
  type ExecRunner,
  type RawExec,
} from "../../src/hooks/index.ts"
import type { HookGroup, LoadedHooks } from "../../src/hooks/schema.ts"

const baseOptions: DispatchOptions = { shell: "/bin/sh", eventBudgetMs: 120000, maxOutputBytes: 16384 }

function loadedWith(event: keyof LoadedHooks["events"], groups: HookGroup[]): LoadedHooks {
  return {
    events: {
      PreToolUse: [],
      PostToolUse: [],
      UserPromptSubmit: [],
      SessionStart: [],
      Stop: [],
      PreCompact: [],
      SessionEnd: [],
      [event]: groups,
    },
    problems: [],
    sources: [],
    totalHooks: groups.reduce((sum, g) => sum + g.hooks.length, 0),
  }
}

function group(matcherSource: string | null, commands: string[], timeoutMs = 60000): HookGroup {
  let matcher: RegExp | null = null

  if (matcherSource !== null && matcherSource.length > 0 && matcherSource !== "*") {
    matcher = new RegExp(matcherSource)
  }

  return {
    matcher,
    matcherSource: matcherSource ?? "",
    hooks: commands.map((command) => ({ command, timeoutMs, source: "test" })),
    source: "test",
  }
}

function runnerOf(results: RawExec[]): { exec: ExecRunner; calls: string[] } {
  const calls: string[] = []
  let i = 0
  const exec: ExecRunner = async (_command, args) => {
    calls.push(args[1])
    const out = results[Math.min(i, results.length - 1)]
    i += 1
    return out
  }
  return { exec, calls }
}

describe("History", () => {
  test("ring buffer keeps last N", () => {
    const history = new History(2)
    history.push({ at: "1", event: "Stop", command: "a", outcome: "ok", exitCode: 0, durationMs: 0, detail: "" })
    history.push({ at: "2", event: "Stop", command: "b", outcome: "ok", exitCode: 0, durationMs: 0, detail: "" })
    history.push({ at: "3", event: "Stop", command: "c", outcome: "ok", exitCode: 0, durationMs: 0, detail: "" })
    expect(history.list().map((r) => r.command)).toEqual(["b", "c"])
  })

  test("size <= 0 caps at 1", () => {
    const history = new History(0)
    history.push({ at: "1", event: "Stop", command: "a", outcome: "ok", exitCode: 0, durationMs: 0, detail: "" })
    history.push({ at: "2", event: "Stop", command: "b", outcome: "ok", exitCode: 0, durationMs: 0, detail: "" })
    expect(history.list().map((r) => r.command)).toEqual(["b"])
  })
})

describe("basePayload", () => {
  test("session_id and transcript_path both equal session file", () => {
    const payload = basePayload({ sessionFile: "/tmp/s.jsonl", cwd: "/proj" }, "SessionStart")
    expect(payload).toEqual({
      session_id: "/tmp/s.jsonl",
      transcript_path: "/tmp/s.jsonl",
      cwd: "/proj",
      hook_event_name: "SessionStart",
    })
  })

  test("missing session file becomes unknown", () => {
    const payload = basePayload({ sessionFile: "", cwd: "/proj" }, "Stop")
    expect(payload.session_id).toBe("unknown")
    expect(payload.transcript_path).toBe("unknown")
  })
})

describe("helpers", () => {
  const d = new Dispatcher(async () => ({}), baseOptions)

  test("shellQuote escapes single quotes", () => {
    expect(d.shellQuote("a'b")).toBe("'a'\\''b'")
  })

  test("clip appends truncated marker beyond cap", () => {
    expect(d.clip("abc", 10)).toBe("abc")
    expect(d.clip("abcdef", 3)).toBe("abc\n[truncated]")
  })

  test("shortCommand collapses whitespace and truncates at 80", () => {
    expect(d.shortCommand("echo   hi\n  there")).toBe("echo hi there")
    const long = "x".repeat(200)
    expect(d.shortCommand(long)).toBe("x".repeat(77) + "...")
  })

  test("makeRecord trims detail to 160 chars and collapses whitespace", () => {
    const record = d.makeRecord("Stop", { command: "c", timeoutMs: 1, source: "s" }, "ok", 0, 5, "a\n\n b  ")
    expect(record.detail).toBe("a b")
    expect(record.command).toBe("c")
  })

  test("normalizeResult coerces unknown shapes", () => {
    expect(d.normalizeResult({ stdout: "o", stderr: "e", code: 1, killed: true })).toEqual({
      stdout: "o",
      stderr: "e",
      code: 1,
      killed: true,
    })
    expect(d.normalizeResult(null)).toEqual({ stdout: "", stderr: "", code: null, killed: false })
    expect(d.normalizeResult({ code: Number.NaN })).toEqual({ stdout: "", stderr: "", code: null, killed: false })
  })
})

describe("sanitize", () => {
  const d = new Dispatcher(async () => ({}), baseOptions)

  test("bigint to string, function/symbol dropped", () => {
    const out = d.sanitize({ a: 1n, b: () => 1, c: Symbol("x"), d: 3 }, []) as Record<string, unknown>
    expect(out).toEqual({ a: "1", d: 3 })
  })

  test("circular refs become [circular]", () => {
    const obj: Record<string, unknown> = { name: "root" }
    obj.self = obj
    const out = d.sanitize(obj, []) as Record<string, unknown>
    expect(out).toEqual({ name: "root", self: "[circular]" })
  })

  test("arrays keep undefined-as-null", () => {
    const out = d.sanitize([1, () => 2, 3], []) as unknown[]
    expect(out).toEqual([1, null, 3])
  })
})

describe("parseDecision", () => {
  const d = new Dispatcher(async () => ({}), baseOptions)

  test("non-brace prefix is not a decision", () => {
    expect(d.parseDecision("plain text")).toBeNull()
  })

  test("leading whitespace then json is parsed", () => {
    expect(d.parseDecision('   {"decision":"block","reason":"no"}')).toEqual({ decision: "block", reason: "no" })
  })

  test("approve decision", () => {
    expect(d.parseDecision('{"decision":"approve"}')).toEqual({ decision: "approve", reason: "" })
  })

  test("other decision string treated as non-decision", () => {
    expect(d.parseDecision('{"decision":"maybe"}')).toBeNull()
  })

  test("invalid json returns null", () => {
    expect(d.parseDecision("{broken")).toBeNull()
  })

  test("array is not a decision", () => {
    expect(d.parseDecision("[1,2]")).toBeNull()
  })
})

describe("dispatch outcomes", () => {
  test("no groups returns empty outcome", async () => {
    const d = new Dispatcher(async () => ({ code: 0 }), baseOptions)
    const loaded = loadedWith("Stop", [])
    const result = await d.dispatch(loaded, new History(10), "Stop", null, {})
    expect(result).toEqual({ blocked: false, reason: "", approved: false, context: [] })
  })

  test("exit 0 with stdout becomes context", async () => {
    const { exec } = runnerOf([{ stdout: "hello\n", code: 0 }])
    const d = new Dispatcher(exec, baseOptions)
    const history = new History(10)
    const loaded = loadedWith("UserPromptSubmit", [group(null, ["echo hi"])])
    const result = await d.dispatch(loaded, history, "UserPromptSubmit", null, { prompt: "p" })
    expect(result.context).toEqual(["hello"])
    expect(history.list()[0].outcome).toBe("context")
  })

  test("exit 0 empty stdout records ok", async () => {
    const { exec } = runnerOf([{ stdout: "  ", code: 0 }])
    const d = new Dispatcher(exec, baseOptions)
    const history = new History(10)
    const loaded = loadedWith("Stop", [group(null, ["true"])])
    const result = await d.dispatch(loaded, history, "Stop", null, {})
    expect(result.context).toEqual([])
    expect(history.list()[0].outcome).toBe("ok")
  })

  test("exit 2 blocks using stderr reason", async () => {
    const { exec } = runnerOf([{ stderr: "denied\n", code: 2 }])
    const d = new Dispatcher(exec, baseOptions)
    const history = new History(10)
    const loaded = loadedWith("PreToolUse", [group(null, ["false"])])
    const result = await d.dispatch(loaded, history, "PreToolUse", "Bash", {})
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe("denied")
    expect(history.list()[0].outcome).toBe("block")
  })

  test("exit 2 with empty stderr falls back to default reason", async () => {
    const { exec } = runnerOf([{ stderr: "", code: 2 }])
    const d = new Dispatcher(exec, baseOptions)
    const loaded = loadedWith("Stop", [group(null, ["false"])])
    const result = await d.dispatch(loaded, new History(10), "Stop", null, {})
    expect(result.reason).toBe("blocked by Stop hook")
  })

  test("other non-zero exit logged as error and continues", async () => {
    const { exec } = runnerOf([{ stderr: "boom", code: 7 }])
    const d = new Dispatcher(exec, baseOptions)
    const history = new History(10)
    const loaded = loadedWith("Stop", [group(null, ["x"])])
    const result = await d.dispatch(loaded, history, "Stop", null, {})
    expect(result.blocked).toBe(false)
    expect(history.list()[0].outcome).toBe("error")
    expect(history.list()[0].detail).toBe("boom")
  })

  test("non-zero exit without stderr records exit code N", async () => {
    const { exec } = runnerOf([{ code: 7 }])
    const d = new Dispatcher(exec, baseOptions)
    const history = new History(10)
    const loaded = loadedWith("Stop", [group(null, ["x"])])
    await d.dispatch(loaded, history, "Stop", null, {})
    expect(history.list()[0].detail).toBe("exit code 7")
  })

  test("killed records timeout", async () => {
    const { exec } = runnerOf([{ killed: true, code: null }])
    const d = new Dispatcher(exec, baseOptions)
    const history = new History(10)
    const loaded = loadedWith("Stop", [group(null, ["sleep 99"])])
    await d.dispatch(loaded, history, "Stop", null, {})
    expect(history.list()[0].outcome).toBe("timeout")
    expect(history.list()[0].detail).toContain("killed after")
  })

  test("PreToolUse decision block stops loop", async () => {
    const { exec, calls } = runnerOf([
      { stdout: '{"decision":"block","reason":"nope"}', code: 0 },
      { stdout: "second", code: 0 },
    ])
    const d = new Dispatcher(exec, baseOptions)
    const loaded = loadedWith("PreToolUse", [group(null, ["a", "b"])])
    const result = await d.dispatch(loaded, new History(10), "PreToolUse", "Bash", {})
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe("nope")
    expect(calls.length).toBe(1)
  })

  test("PreToolUse decision approve continues without context", async () => {
    const { exec } = runnerOf([{ stdout: '{"decision":"approve"}', code: 0 }])
    const d = new Dispatcher(exec, baseOptions)
    const history = new History(10)
    const loaded = loadedWith("PreToolUse", [group(null, ["a"])])
    const result = await d.dispatch(loaded, history, "PreToolUse", "Bash", {})
    expect(result.approved).toBe(true)
    expect(result.context).toEqual([])
    expect(history.list()[0].outcome).toBe("approve")
  })

  test("decision documents only honored for PreToolUse", async () => {
    const { exec } = runnerOf([{ stdout: '{"decision":"block","reason":"x"}', code: 0 }])
    const d = new Dispatcher(exec, baseOptions)
    const loaded = loadedWith("PostToolUse", [group(null, ["a"])])
    const result = await d.dispatch(loaded, new History(10), "PostToolUse", "Bash", {})
    expect(result.blocked).toBe(false)
    expect(result.context).toEqual(['{"decision":"block","reason":"x"}'])
  })

  test("matcher selects matching tool only", async () => {
    const { exec, calls } = runnerOf([{ code: 0 }])
    const d = new Dispatcher(exec, baseOptions)
    const loaded = loadedWith("PreToolUse", [group("Bash", ["only-bash"]), group("Edit", ["only-edit"])])
    await d.dispatch(loaded, new History(10), "PreToolUse", "Bash", {})
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain("only-bash")
  })

  test("budget exhaustion skips remaining hooks", async () => {
    const slow: ExecRunner = async () => {
      const target = Date.now() + 6
      let now = Date.now()

      while (now < target) {
        now = Date.now()
      }

      return { code: 0 }
    }
    const d = new Dispatcher(slow, { ...baseOptions, eventBudgetMs: 5 })
    const history = new History(10)
    const loaded = loadedWith("Stop", [group(null, ["a", "b"])])
    await d.dispatch(loaded, history, "Stop", null, {})
    const outcomes = history.list().map((r) => r.outcome)
    expect(outcomes).toContain("skipped")
  })

  test("exec throwing records error", async () => {
    const exec: ExecRunner = async () => {
      throw new Error("spawn fail")
    }
    const d = new Dispatcher(exec, baseOptions)
    const history = new History(10)
    const loaded = loadedWith("Stop", [group(null, ["x"])])
    await d.dispatch(loaded, history, "Stop", null, {})
    expect(history.list()[0].outcome).toBe("error")
    expect(history.list()[0].detail).toBe("spawn fail")
  })

  test("non-matching matcher dispatches nothing", async () => {
    const { exec, calls } = runnerOf([{ code: 0 }])
    const d = new Dispatcher(exec, baseOptions)
    const loaded = loadedWith("PreToolUse", [group("Bash", ["x"])])
    const result = await d.dispatch(loaded, new History(10), "PreToolUse", "Edit", {})
    expect(calls.length).toBe(0)
    expect(result.blocked).toBe(false)
  })

  test("two matched hooks each run independently", async () => {
    const { exec, calls } = runnerOf([
      { stdout: "first\n", code: 0 },
      { stdout: "second\n", code: 0 },
    ])
    const d = new Dispatcher(exec, baseOptions)
    const history = new History(10)
    const loaded = loadedWith("UserPromptSubmit", [group(null, ["a", "b"])])
    const result = await d.dispatch(loaded, history, "UserPromptSubmit", null, { prompt: "p" })
    expect(calls.length).toBe(2)
    expect(result.context).toEqual(["first", "second"])
    expect(history.list().map((r) => r.outcome)).toEqual(["context", "context"])
  })
})
