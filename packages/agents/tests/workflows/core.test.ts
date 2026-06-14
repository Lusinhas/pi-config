import { describe, expect, test } from "bun:test"
import {
  Workflows,
  ITEM_CAP,
  RESULT_CAP,
  DELIVERY_MAX_ATTEMPTS
} from "../../src/workflows/index.ts"
import type {
  AgentDefinition,
  AgentRegistry,
  DeliveryMessage,
  ModelSource,
  RunContext,
  RunEntry,
  RunnerLike,
  TaskOutcome,
  ToolOutput,
  WorkflowParams
} from "../../src/workflows/index.ts"

interface RunnerScript {
  text?: string
  structured?: unknown
  tokens?: number
  turns?: number
  throws?: Error
}

class FakeRunner implements RunnerLike {
  depthError: Error | undefined
  readonly calls: { definition: AgentDefinition; task: string; via: string }[] = []
  private readonly script: RunnerScript[]
  private cursor = 0
  slotDepth = 0

  constructor(script: RunnerScript[] = []) {
    this.script = script
  }

  ensureDepth(): void {
    if (this.depthError) {
      throw this.depthError
    }
  }

  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    this.slotDepth += 1

    try {
      return await fn()
    } finally {
      this.slotDepth -= 1
    }
  }

  async runAgent(
    definition: AgentDefinition,
    task: string,
    _context: string | undefined,
    _source: ModelSource & { cwd: string },
    _signal: AbortSignal | undefined,
    _onTurn?: (turns: number) => void,
    via = "",
    onTokens?: (tokens: number) => void
  ): Promise<TaskOutcome> {
    this.calls.push({ definition, task, via })
    const step = this.script[this.cursor] ?? {}
    this.cursor += 1

    if (step.throws) {
      throw step.throws
    }

    const tokens = step.tokens ?? 0

    if (onTokens && tokens > 0) {
      onTokens(tokens)
    }

    return {
      agent: definition.name,
      model: definition.model,
      text: step.text ?? "ok",
      turns: step.turns ?? 1,
      tokens,
      capped: false,
      structured: step.structured,
      dropped: []
    }
  }
}

class FakeHost {
  readonly runs: RunEntry[] = []
  readonly sent: DeliveryMessage[] = []

  appendRun(entry: RunEntry): void {
    this.runs.push({ ...entry })
  }

  sendResult(message: DeliveryMessage): void {
    this.sent.push(message)
  }
}

function emptyRegistry(): AgentRegistry {
  return { agents: new Map(), errors: [], paths: [] }
}

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    cwd: "/tmp/project",
    hasUI: true,
    model: { id: "m" },
    modelRegistry: {},
    isProjectTrusted: () => false,
    isIdle: () => true,
    getEntries: () => [],
    notify: () => {},
    ...overrides
  }
}

function manager(runner: RunnerLike, host: FakeHost, registry: AgentRegistry = emptyRegistry()): Workflows {
  return new Workflows({ timeoutSec: 30, maxAgents: 250 }, host, runner, () => registry)
}

function meta(body: string): string {
  return `export const meta = { name: "t", description: "d" }\n${body}`
}

describe("Workflows.execute guards", () => {
  test("requires exactly one of script or name", async () => {
    const m = manager(new FakeRunner(), new FakeHost())

    await expect(m.execute({}, undefined, undefined, context())).rejects.toThrow("provide exactly one of script")
    await expect(m.execute({ script: "x", name: "y" }, undefined, undefined, context())).rejects.toThrow("provide exactly one of script")
  })

  test("ensureDepth error propagates", async () => {
    const runner = new FakeRunner()
    runner.depthError = new Error("depth limit reached")
    const m = manager(runner, new FakeHost())

    await expect(m.execute({ script: meta("return 1") }, undefined, undefined, context())).rejects.toThrow("depth limit reached")
  })

  test("invalid args JSON throws", async () => {
    const m = manager(new FakeRunner(), new FakeHost())

    await expect(m.execute({ script: meta("return 1"), args: "{bad" }, undefined, undefined, context())).rejects.toThrow("the args parameter must be valid JSON")
  })
})

describe("Workflows.execute foreground", () => {
  test("returns rendered value and details with run id format", async () => {
    const host = new FakeHost()
    const m = manager(new FakeRunner(), host)
    const out = await m.execute({ script: meta("return { ok: true }") }, undefined, undefined, context())

    expect(out.content[0].text).toBe("{\n  \"ok\": true\n}")
    expect(out.details?.runId).toMatch(/^wf_[0-9a-f-]{12}$/)
    expect(out.details?.agents).toBe(0)
    expect(out.details?.tokens).toBe(0)
    expect(host.runs).toHaveLength(1)
    expect(host.runs[0].state).toBe("done")
  })

  test("undefined return renders placeholder", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const out = await m.execute({ script: meta("return undefined") }, undefined, undefined, context())

    expect(out.content[0].text).toBe("(the workflow script returned no value)")
  })

  test("agent default worker runs and counts tokens", async () => {
    const runner = new FakeRunner([{ text: "result-text", turns: 2, tokens: 15 }])
    const host = new FakeHost()
    const m = manager(runner, host)
    const out = await m.execute({ script: meta("const r = await agent('do a thing'); return r") }, undefined, undefined, context())

    expect(out.content[0].text).toBe("\"result-text\"")
    expect(out.details?.tokens).toBe(15)
    expect(out.details?.agents).toBe(1)
    expect(runner.calls[0].definition.name).toBe("worker")
    expect(runner.calls[0].via).toMatch(/^workflow:wf_/)
  })

  test("onUpdate emits progress text", async () => {
    const updates: ToolOutput[] = []
    const m = manager(new FakeRunner([{ tokens: 3 }]), new FakeHost())
    await m.execute({ script: meta("await agent('x'); return 1") }, undefined, (p) => updates.push(p), context())

    expect(updates.length).toBeGreaterThan(0)
    expect(updates[0].content[0].text).toContain("workflow t wf_")
  })

  test("unknown named agent throws with available list", async () => {
    const registry: AgentRegistry = {
      agents: new Map([["librarian", { name: "librarian", description: "", model: "inherit", tools: "all", thinking: "", prompt: "p", source: "s" } as AgentDefinition]]),
      errors: [],
      paths: []
    }
    const m = manager(new FakeRunner(), new FakeHost(), registry)
    const script = meta("await agent('x', { agent: 'ghost' }); return 1")

    await expect(m.execute({ script }, undefined, undefined, context())).rejects.toThrow('workflow: unknown agent "ghost" (available: librarian)')
  })

  test("agent model override applies", async () => {
    const runner = new FakeRunner([{ tokens: 1 }])
    const m = manager(runner, new FakeHost())
    await m.execute({ script: meta("await agent('x', { model: 'fast' }); return 1") }, undefined, undefined, context())

    expect(runner.calls[0].definition.model).toBe("fast")
  })

  test("agent schema invalid type throws", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const script = meta("await agent('x', { schema: 5 }); return 1")

    await expect(m.execute({ script }, undefined, undefined, context())).rejects.toThrow("agent() schema must be a JSON schema object")
  })

  test("agent cap aborts the run", async () => {
    const runner = new FakeRunner(Array.from({ length: 5 }, () => ({ tokens: 0 })))
    const host = new FakeHost()
    const m = new Workflows({ timeoutSec: 30, maxAgents: 2 }, host, runner, () => emptyRegistry())
    const script = meta("for (let i = 0; i < 5; i++) { await agent('x' + i); } return 'done'")

    await expect(m.execute({ script }, undefined, undefined, context())).rejects.toThrow(/the agent cap of 2/)
  })
})

describe("Workflows.execute dedupe cache", () => {
  test("identical agent calls within a run reuse the first outcome", async () => {
    const runner = new FakeRunner([{ text: "answer", tokens: 11 }, { text: "second", tokens: 99 }])
    const m = manager(runner, new FakeHost())
    const script = meta("const a = await agent('same prompt'); const b = await agent('same prompt'); return [a, b]")
    const out = await m.execute({ script }, undefined, undefined, context())

    expect(JSON.parse(out.content[0].text)).toEqual(["answer", "answer"])
    expect(runner.calls).toHaveLength(1)
    expect(out.details?.tokens).toBe(11)
  })

  test("different prompts are not deduped", async () => {
    const runner = new FakeRunner([{ text: "one", tokens: 4 }, { text: "two", tokens: 6 }])
    const m = manager(runner, new FakeHost())
    const script = meta("const a = await agent('first'); const b = await agent('second'); return [a, b]")
    const out = await m.execute({ script }, undefined, undefined, context())

    expect(JSON.parse(out.content[0].text)).toEqual(["one", "two"])
    expect(runner.calls).toHaveLength(2)
  })
})

describe("Workflows.execute schema flow", () => {
  test("valid structured output returned, logged as structured", async () => {
    const runner = new FakeRunner([{ structured: { ok: 1 }, tokens: 9 }])
    const m = manager(runner, new FakeHost())
    const script = meta("const r = await agent('x', { schema: { type: 'object' } }); return r")
    const out = await m.execute({ script }, undefined, undefined, context())

    expect(out.content[0].text).toBe("{\n  \"ok\": 1\n}")
  })

  test("missing structured retries once then succeeds", async () => {
    const runner = new FakeRunner([{ structured: undefined }, { structured: { ok: true } }])
    const m = manager(runner, new FakeHost())
    const script = meta("const r = await agent('x', { schema: { type: 'object' } }); return r")
    const out = await m.execute({ script }, undefined, undefined, context())

    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[1].task).toContain("failed schema validation")
    expect(out.content[0].text).toBe("{\n  \"ok\": true\n}")
  })

  test("persistent schema failure resolves to null", async () => {
    const runner = new FakeRunner([{ structured: undefined }, { structured: undefined }])
    const m = manager(runner, new FakeHost())
    const script = meta("const r = await agent('x', { schema: { type: 'object' } }); return r === null ? 'NULLED' : r")
    const out = await m.execute({ script }, undefined, undefined, context())

    expect(out.content[0].text).toBe("\"NULLED\"")
  })

  test("agent failure resolves to null (not aborted)", async () => {
    const runner = new FakeRunner([{ throws: new Error("boom") }])
    const m = manager(runner, new FakeHost())
    const script = meta("const r = await agent('x'); return r === null ? 'NULL' : r")
    const out = await m.execute({ script }, undefined, undefined, context())

    expect(out.content[0].text).toBe("\"NULL\"")
  })
})

describe("Workflows.execute parallel and pipeline", () => {
  test("parallel runs thunks and collects results", async () => {
    const runner = new FakeRunner([{ text: "a" }, { text: "b" }])
    const m = manager(runner, new FakeHost())
    const script = meta("const r = await parallel([() => agent('one'), () => agent('two')]); return r")
    const out = await m.execute({ script }, undefined, undefined, context())

    expect(JSON.parse(out.content[0].text)).toEqual(["a", "b"])
  })

  test("parallel rejects non-array", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const script = meta("await parallel('nope'); return 1")

    await expect(m.execute({ script }, undefined, undefined, context())).rejects.toThrow("parallel() expects an array of functions")
  })

  test("parallel rejects non-function elements", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const script = meta("await parallel([agent('x')]); return 1")

    await expect(m.execute({ script }, undefined, undefined, context())).rejects.toThrow("parallel() expects an array of functions")
  })

  test("parallel rejects oversize", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const script = meta(`await parallel(Array.from({ length: ${ITEM_CAP + 1} }, () => () => null)); return 1`)

    await expect(m.execute({ script }, undefined, undefined, context())).rejects.toThrow(`parallel() supports at most ${ITEM_CAP}`)
  })

  test("pipeline flows items through stages and short-circuits null", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const script = meta("const r = await pipeline([1, 2, 3], (v) => v % 2 === 0 ? null : v, (v) => v * 10); return r")
    const out = await m.execute({ script }, undefined, undefined, context())

    expect(JSON.parse(out.content[0].text)).toEqual([10, null, 30])
  })

  test("pipeline rejects non-array items", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const script = meta("await pipeline(5, (v) => v); return 1")

    await expect(m.execute({ script }, undefined, undefined, context())).rejects.toThrow("pipeline() expects an array of items")
  })

  test("pipeline rejects non-function stage", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const script = meta("await pipeline([1], 5); return 1")

    await expect(m.execute({ script }, undefined, undefined, context())).rejects.toThrow("pipeline() stages must be functions")
  })

  test("pipeline rejects oversize", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const script = meta(`await pipeline(Array.from({ length: ${ITEM_CAP + 1} }, (_, i) => i)); return 1`)

    await expect(m.execute({ script }, undefined, undefined, context())).rejects.toThrow(`pipeline() supports at most ${ITEM_CAP}`)
  })
})

describe("Workflows.execute failure and abort", () => {
  test("thrown error in script marks failed and wraps reason", async () => {
    const host = new FakeHost()
    const m = manager(new FakeRunner(), host)
    const script = meta("throw new Error('script blew up')")

    await expect(m.execute({ script }, undefined, undefined, context())).rejects.toThrow(/workflow wf_.* \(t\) failed: script blew up/)
    expect(host.runs[0].state).toBe("failed")
  })

  test("parent signal abort marks aborted", async () => {
    const host = new FakeHost()
    const m = manager(new FakeRunner(), host)
    const controller = new AbortController()
    const script = meta("await new Promise(() => {}); return 1")
    const promise = m.execute({ script }, controller.signal, undefined, context())
    setTimeout(() => controller.abort(), 20)

    await expect(promise).rejects.toThrow(/aborted/)
    expect(host.runs[0].state).toBe("aborted")
  })
})

describe("Workflows.execute background", () => {
  test("returns immediately and delivers on completion", async () => {
    const host = new FakeHost()
    const runner = new FakeRunner([{ text: "bg", tokens: 4 }])
    const m = manager(runner, host)
    const ctx = context()
    const out = await m.execute({ script: meta("const r = await agent('x'); return r"), background: true }, undefined, undefined, ctx)

    expect(out.content[0].text).toContain("Background workflow run wf_")
    expect(out.details?.background).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(host.sent.length).toBeGreaterThan(0)
    expect(host.sent[0].customType).toBe("workflows:result")
    expect(host.sent[0].content).toContain("background run wf_")
    expect(host.sent[0].content).toContain("completed:")
    expect(typeof host.sent[0].details.deliveryKey).toBe("string")

    m.stopDeliveries()
  })

  test("delivery waits for confirmation then stops", async () => {
    const host = new FakeHost()
    const m = manager(new FakeRunner(), host)
    let entries: unknown[] = []
    const ctx = context({ getEntries: () => entries })
    await m.execute({ script: meta("return 'x'"), background: true }, undefined, undefined, ctx)

    await new Promise((resolve) => setTimeout(resolve, 30))
    const firstKey = host.sent[0]?.details.deliveryKey
    expect(typeof firstKey).toBe("string")

    entries = [{ type: "custom_message", customType: "workflows:result", details: { deliveryKey: firstKey } }]
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_MAX_ATTEMPTS > 0 ? 1100 : 50))

    m.stopDeliveries()
  })
})

describe("Workflows.command", () => {
  test("no UI returns early", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    let notified = false
    await m.command("", context({ hasUI: false, notify: () => { notified = true } }))

    expect(notified).toBe(false)
  })

  test("kill with empty id notifies error", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const messages: { text: string; level: string }[] = []
    await m.command("kill", context({ notify: (text, level) => messages.push({ text, level }) }))

    expect(messages[0].level).toBe("error")
    expect(messages[0].text).toContain("no running run")
  })

  test("kill unknown id notifies error", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const messages: { text: string; level: string }[] = []
    await m.command("kill wf_missing", context({ notify: (text, level) => messages.push({ text, level }) }))

    expect(messages[0].level).toBe("error")
  })

  test("show unknown id lists known ids", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const messages: { text: string; level: string }[] = []
    await m.command("show wf_x", context({ notify: (text, level) => messages.push({ text, level }) }))

    expect(messages[0].level).toBe("error")
    expect(messages[0].text).toContain("no run")
  })

  test("report lists saved (none) and runs (none)", async () => {
    const m = manager(new FakeRunner(), new FakeHost())
    const messages: string[] = []
    await m.command("", context({ notify: (text) => messages.push(text) }))

    expect(messages[0]).toContain("Saved workflows (0):")
    expect(messages[0]).toContain("Workflow runs this session (0):")
    expect(messages[0]).toContain("none")
  })

  test("report includes live run and history from entries", async () => {
    const host = new FakeHost()
    const m = manager(new FakeRunner(), host)
    await m.execute({ script: meta("return 1") }, undefined, undefined, context())

    const history = [{ type: "custom", customType: "workflows:run", data: { id: "wf_old", name: "older", agentCount: 2, state: "done", startedAt: 1, endedAt: 2 } }]
    const messages: string[] = []
    await m.command("", context({ getEntries: () => history, notify: (text) => messages.push(text) }))

    expect(messages[0]).toContain("wf_old older")
    expect(messages[0]).toContain("earlier in this session file")
  })

  test("show known run prints header and logs", async () => {
    const host = new FakeHost()
    const runner = new FakeRunner([{ text: "r", turns: 1, tokens: 2 }])
    const m = manager(runner, host)
    const out = await m.execute({ script: meta("await agent('x'); return 1") }, undefined, undefined, context())
    const id = out.details?.runId as string

    const messages: string[] = []
    await m.command(`show ${id}`, context({ notify: (text) => messages.push(text) }))

    expect(messages[0]).toContain(`${id} (t) —`)
    expect(messages[0]).toContain("agent[1]")
  })
})

describe("Workflows static helpers", () => {
  test("formatDuration boundaries", () => {
    expect(Workflows.formatDuration(0, 59_000)).toBe("59s")
    expect(Workflows.formatDuration(0, 60_000)).toBe("1m0s")
    expect(Workflows.formatDuration(0, 3_600_000)).toBe("1h0m")
  })

  test("stateMark mapping", () => {
    expect(Workflows.stateMark("running")).toBe("▶")
    expect(Workflows.stateMark("done")).toBe("✓")
    expect(Workflows.stateMark("aborted")).toBe("■")
    expect(Workflows.stateMark("failed")).toBe("✗")
    expect(Workflows.stateMark("weird")).toBe("✗")
  })

  test("collapse normalizes whitespace", () => {
    expect(Workflows.collapse("  a\n  b\t c  ")).toBe("a b c")
  })

  test("renderValue truncates above the cap", () => {
    const big = "x".repeat(RESULT_CAP + 100)
    const rendered = Workflows.renderValue(big)

    expect(rendered).toContain("[workflow result truncated:")
    expect(rendered.length).toBeLessThan(big.length + 200)
  })

  test("renderValue handles non-serializable", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(Workflows.renderValue(circular)).toContain("could not be serialized")
  })

  test("renderLog stringifies non-strings", () => {
    expect(Workflows.renderLog({ a: 1 })).toBe("{\"a\":1}")
    expect(Workflows.renderLog("plain")).toBe("plain")
  })

  test("trimStack keeps message and workflow.js frames", () => {
    const error = new Error("oops")
    error.stack = "Error: oops\n    at foo (workflow.js:1:1)\n    at bar (other.js:2:2)\n    at baz (workflow.js:3:3)"

    expect(Workflows.trimStack(error)).toBe("oops\nat foo (workflow.js:1:1)\nat baz (workflow.js:3:3)")
  })

  test("trimStack returns message when no workflow frames", () => {
    const error = new Error("plain")
    error.stack = "Error: plain\n    at x (other.js:1:1)"

    expect(Workflows.trimStack(error)).toBe("plain")
  })

  test("schemaInstruction embeds serialized schema", () => {
    const text = Workflows.schemaInstruction({ type: "object" })

    expect(text).toContain("Structured output requirement")
    expect(text).toContain("{\"type\":\"object\"}")
  })

  test("progressText composes line, phases, and last logs", () => {
    const text = Workflows.progressText({
      id: "wf_p",
      name: "n",
      state: "running",
      phases: [{ title: "scan", agents: 1 }],
      logs: ["l1", "l2", "l3", "l4", "l5"],
      agentCount: 1,
      tokens: 3,
      startedAt: 0,
      endedAt: 1000
    })

    expect(text).toContain("workflow n wf_p: running · 1 agents · 3 tokens · 1s")
    expect(text).toContain("phases: scan(1)")
    expect(text).toContain("l2\nl3\nl4\nl5")
    expect(text).not.toContain("l1")
  })

  test("scriptDirs respects trust", () => {
    const trusted = Workflows.scriptDirs("/proj", true)
    const untrusted = Workflows.scriptDirs("/proj", false)

    expect(trusted).toHaveLength(2)
    expect(trusted[1]).toContain("/proj")
    expect(untrusted).toHaveLength(1)
  })

  test("parseArgs", () => {
    expect(Workflows.parseArgs(undefined)).toBeUndefined()
    expect(Workflows.parseArgs("  ")).toBeUndefined()
    expect(Workflows.parseArgs("{\"a\":1}")).toEqual({ a: 1 })
    expect(() => Workflows.parseArgs("{bad")).toThrow("must be valid JSON")
  })

  test("description includes caps line", () => {
    const m = new Workflows({ timeoutSec: 1800, maxAgents: 250 }, new FakeHost(), new FakeRunner(), () => emptyRegistry())
    const text = m.description()

    expect(text.split("\n")).toHaveLength(5)
    expect(text).toContain(`Caps: 250 agents per run, 1800s wall clock, ${ITEM_CAP} items per parallel/pipeline call`)
    expect(text).toContain("maxTokens (per-agent token ceiling for agents this run spawns; default unbounded)")
    expect(text).toContain("maxAgents (override the fan-out cap for this run)")
  })

  test("loadNamed invalid name rejected", async () => {
    const m = manager(new FakeRunner(), new FakeHost())

    await expect(m.execute({ name: "../etc/passwd" }, undefined, undefined, context())).rejects.toThrow('invalid workflow name "../etc/passwd"')
  })

  test("loadNamed not found lists searched paths", async () => {
    const m = manager(new FakeRunner(), new FakeHost())

    await expect(m.execute({ name: "ghost" }, undefined, undefined, context())).rejects.toThrow('no saved workflow named "ghost"')
  })
})
