import { describe, expect, test } from "bun:test"
import {
  BUILTIN_TOOLS,
  Runner
} from "../../src/subagents/index.ts"
import type {
  DeliveryContext
} from "../../src/subagents/index.ts"
import {
  extractMessageText,
  extractStructured,
  extractText,
  LoopEngine,
  usageTokens,
  YIELD_INSTRUCTION
} from "../../src/subagents/engine.ts"
import type {
  CreatedSession,
  SessionCreateOptions,
  SessionFactory,
  SessionLike
} from "../../src/subagents/engine.ts"
import {
  describeModel,
  findModel,
  readDepth,
  readLabel,
  resolveModel,
  RouterRoles,
  withDepthMarker
} from "../../src/subagents/model.ts"
import type { SubagentsConfig } from "../../src/subagents/config.ts"
import type { AgentDefinition } from "../../src/subagents/registry.ts"

const CONFIG: SubagentsConfig = {
  maxConcurrent: 4,
  maxDepth: 2,
  maxTokens: 0,
  advisorModel: "",
  advisorThinking: "xhigh",
  advisorContextChars: 60000,
  widget: true,
  widgetLimit: 4,
  transcriptLimit: 60,
  activityChars: 100,
  keepFinished: 20,
  teams: {}
}

function noRoles(): RouterRoles {
  const roles = new RouterRoles("/nowhere")
  ;(roles as unknown as { cached: Record<string, unknown> }).cached = {}

  return roles
}

class FakeSession implements SessionLike {
  messages: unknown[] = []
  private listener?: (event: Record<string, unknown>) => void
  aborted = false
  disposed = false
  readonly script: () => Promise<void>

  constructor(script: (session: FakeSession) => Promise<void>) {
    this.script = () => script(this)
  }

  subscribe(listener: (event: Record<string, unknown>) => void): () => void {
    this.listener = listener

    return () => {
      this.listener = undefined
    }
  }

  emit(event: Record<string, unknown>): void {
    this.listener?.(event)
  }

  async prompt(): Promise<void> {
    await this.script()
  }

  abort(): void {
    this.aborted = true
  }

  dispose(): void {
    this.disposed = true
  }
}

function factoryFor(builder: (options: SessionCreateOptions) => CreatedSession): SessionFactory {
  return {
    async createSession(options: SessionCreateOptions): Promise<CreatedSession> {
      return builder(options)
    }
  }
}

function assistantMessage(text: string, tokens = 0): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "text", text }], usage: { totalTokens: tokens } }
}

describe("withDepthMarker", () => {
  test("restores depth and label after the callback", async () => {
    expect(readDepth()).toBe(0)
    expect(readLabel()).toBe("")
    await withDepthMarker(3, "child", async () => {
      expect(readDepth()).toBe(3)
      expect(readLabel()).toBe("child")
    })
    expect(readDepth()).toBe(0)
    expect(readLabel()).toBe("")
  })

  test("keeps the bridge object exactly {depth,label}", async () => {
    const host = globalThis as unknown as Record<symbol, Record<string, unknown> | undefined>
    await withDepthMarker(1, "x", async () => undefined)
    const state = host[Symbol.for("piconfig.subagents.marker")]
    expect(state && Object.keys(state).sort()).toEqual(["depth", "label"])
  })
})

describe("describeModel", () => {
  test("renders provider/id, id, or inherit", () => {
    expect(describeModel({ provider: "anthropic", id: "x" })).toBe("anthropic/x")
    expect(describeModel({ id: "x" })).toBe("x")
    expect(describeModel({})).toBe("inherit")
    expect(describeModel(undefined)).toBe("inherit")
  })
})

describe("resolveModel", () => {
  test("inherit returns the session model", async () => {
    const resolved = await resolveModel("inherit", { model: { id: "session" } }, noRoles())
    expect(resolved.id).toBe("session")
  })

  test("empty spec inherits", async () => {
    const resolved = await resolveModel("", { model: { id: "session" } }, noRoles())
    expect(resolved.id).toBe("session")
  })

  test("resolves a slash spec through registry.find", async () => {
    const registry = { find: (provider: string, id: string) => ({ provider, id }) }
    const resolved = await resolveModel("anthropic/opus", { modelRegistry: registry }, noRoles())
    expect(resolved.id).toBe("anthropic/opus")
  })

  test("throws with via role context when not found", async () => {
    const roles = new RouterRoles("/x")
    ;(roles as unknown as { cached: Record<string, unknown> }).cached = { fast: { model: "vendor/missing" } }
    await expect(resolveModel("fast", { modelRegistry: {} }, roles)).rejects.toThrow("subagents: model \"vendor/missing\" (via role \"fast\") was not found in the model registry")
  })

  test("throws without via for a direct spec", async () => {
    await expect(resolveModel("vendor/missing", { modelRegistry: {} }, noRoles())).rejects.toThrow("subagents: model \"vendor/missing\" was not found in the model registry")
  })
})

describe("findModel", () => {
  test("scans getAvailable for an id match", async () => {
    const registry = { getAvailable: async () => [{ id: "a" }, { provider: "p", id: "b" }] }
    expect(await findModel(registry, "a")).toEqual({ id: "a" })
    expect(await findModel(registry, "p/b")).toEqual({ provider: "p", id: "b" })
    expect(await findModel(registry, "missing")).toBeUndefined()
  })

  test("falls back to getAvailable when find throws", async () => {
    const registry = {
      find: () => {
        throw new Error("registry unavailable")
      },
      getAvailable: async () => [{ provider: "p", id: "b" }]
    }
    expect(await findModel(registry, "p/b")).toEqual({ provider: "p", id: "b" })
  })

  test("falls back to getAvailable when find returns nothing", async () => {
    const registry = {
      find: () => undefined,
      getAvailable: async () => [{ provider: "p", id: "b" }]
    }
    expect(await findModel(registry, "p/b")).toEqual({ provider: "p", id: "b" })
  })
})

describe("message helpers", () => {
  test("extractText returns the last non-empty assistant text", () => {
    const messages = [assistantMessage("first"), { role: "user", content: [] }, assistantMessage("")]
    expect(extractText(messages)).toBe("first")
  })

  test("extractMessageText joins text blocks", () => {
    expect(extractMessageText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb")
    expect(extractMessageText({ role: "user", content: [] })).toBe("")
  })

  test("usageTokens counts new-work tokens and falls back to totalTokens only when absent", () => {
    expect(usageTokens({ role: "assistant", usage: { totalTokens: 42 } })).toBe(42)
    expect(usageTokens({ role: "assistant", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } })).toBe(7)
    expect(usageTokens({ role: "assistant", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 999 } })).toBe(7)
    expect(usageTokens({ role: "user", usage: { totalTokens: 9 } })).toBe(0)
  })

  test("extractStructured returns the last json fenced block", () => {
    expect(extractStructured("text\n```json\n{\"a\":1}\n```\nmore\n```json\n{\"b\":2}\n```")).toEqual({ b: 2 })
    expect(extractStructured("no json here")).toBeUndefined()
    expect(extractStructured("```json\nnot valid\n```")).toBeUndefined()
  })
})

describe("LoopEngine.run", () => {
  test("counts turns and tokens, extracts final text", async () => {
    const factory = factoryFor(() => ({
      session: new FakeSession(async (session) => {
        session.emit({ type: "turn_end" })
        session.emit({ type: "message_end", message: assistantMessage("done", 100) })
        session.messages = [assistantMessage("done", 100)]
      })
    }))
    const engine = new LoopEngine(factory, () => undefined)
    const result = await engine.run({ label: "a", systemPrompt: "p", prompt: "go", cwd: "/x", childDepth: 1, maxTokens: 0 })
    expect(result.text).toBe("done")
    expect(result.turns).toBe(1)
    expect(result.tokens).toBe(100)
    expect(result.capped).toBe(false)
  })

  test("does not cap on turns no matter how many run", async () => {
    let aborted: FakeSession | undefined
    const factory = factoryFor(() => {
      const session = new FakeSession(async (s) => {
        s.emit({ type: "turn_end" })
        s.emit({ type: "turn_end" })
        s.emit({ type: "turn_end" })
        s.messages = [assistantMessage("partial")]
        aborted = s
      })

      return { session }
    })
    const engine = new LoopEngine(factory, () => undefined)
    const result = await engine.run({ label: "a", systemPrompt: "p", prompt: "go", cwd: "/x", childDepth: 1, maxTokens: 0 })
    expect(result.turns).toBe(3)
    expect(result.capped).toBe(false)
    expect(aborted?.aborted).toBe(false)
  })

  test("caps at the token limit and aborts the session", async () => {
    let aborted: FakeSession | undefined
    const factory = factoryFor(() => {
      const session = new FakeSession(async (s) => {
        s.emit({ type: "message_end", message: assistantMessage("x", 5000) })
        s.messages = [assistantMessage("x", 5000)]
        aborted = s
      })

      return { session }
    })
    const engine = new LoopEngine(factory, () => undefined)
    const result = await engine.run({ label: "a", systemPrompt: "p", prompt: "go", cwd: "/x", childDepth: 1, maxTokens: 1000 })
    expect(result.capped).toBe("tokens")
    expect(aborted?.aborted).toBe(true)
  })

  test("propagates a non-capped failure with the label prefix", async () => {
    const factory = factoryFor(() => ({
      session: new FakeSession(async () => {
        throw new Error("boom")
      })
    }))
    const engine = new LoopEngine(factory, () => undefined)
    await expect(engine.run({ label: "agentx", systemPrompt: "p", prompt: "go", cwd: "/x", childDepth: 1, maxTokens: 0 })).rejects.toThrow("agentx: boom")
  })

  test("throws aborted when the parent signal fires", async () => {
    const controller = new AbortController()
    const factory = factoryFor(() => ({
      session: new FakeSession(async (s) => {
        controller.abort()
        s.messages = [assistantMessage("ignored")]
      })
    }))
    const engine = new LoopEngine(factory, () => undefined)
    await expect(engine.run({ label: "ag", systemPrompt: "p", prompt: "go", cwd: "/x", childDepth: 1, maxTokens: 0, signal: controller.signal })).rejects.toThrow("ag: aborted")
  })

  test("throws before start when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const engine = new LoopEngine(factoryFor(() => ({ session: new FakeSession(async () => undefined) })), () => undefined)
    await expect(engine.run({ label: "ag", systemPrompt: "p", prompt: "go", cwd: "/x", childDepth: 1, maxTokens: 0, signal: controller.signal })).rejects.toThrow("ag: aborted before start")
  })

  test("uses the compact resolver for tool previews", async () => {
    const previews: string[] = []
    const factory = factoryFor(() => ({
      session: new FakeSession(async (s) => {
        s.emit({ type: "tool_execution_start", toolName: "read", args: { path: "x" } })
        s.messages = [assistantMessage("ok")]
      })
    }))
    const engine = new LoopEngine(factory, () => (tool, input) => `compact(${tool})`)
    await engine.run({
      label: "a",
      systemPrompt: "p",
      prompt: "go",
      cwd: "/x",
      childDepth: 1,
      maxTokens: 0,
      onEvent: (kind, text) => {
        if (kind === "tool") {
          previews.push(text)
        }
      }
    })
    expect(previews).toEqual(["read compact(read)"])
  })

  test("falls back to a clipped json preview when no compactor", async () => {
    const previews: string[] = []
    const factory = factoryFor(() => ({
      session: new FakeSession(async (s) => {
        s.emit({ type: "tool_execution_start", toolName: "bash", args: { cmd: "ls" } })
        s.messages = [assistantMessage("ok")]
      })
    }))
    const engine = new LoopEngine(factory, () => undefined)
    await engine.run({
      label: "a",
      systemPrompt: "p",
      prompt: "go",
      cwd: "/x",
      childDepth: 1,
      maxTokens: 0,
      onEvent: (kind, text) => {
        if (kind === "tool") {
          previews.push(text)
        }
      }
    })
    expect(previews).toEqual(["bash {\"cmd\":\"ls\"}"])
  })

  test("dedupes consecutive identical tool previews", async () => {
    const previews: string[] = []
    const factory = factoryFor(() => ({
      session: new FakeSession(async (s) => {
        s.emit({ type: "tool_execution_start", toolName: "read", args: { path: "x" } })
        s.emit({ type: "tool_execution_start", toolName: "read", args: { path: "x" } })
        s.messages = [assistantMessage("ok")]
      })
    }))
    const engine = new LoopEngine(factory, () => undefined)
    await engine.run({
      label: "a",
      systemPrompt: "p",
      prompt: "go",
      cwd: "/x",
      childDepth: 1,
      maxTokens: 0,
      onEvent: (kind, text) => {
        if (kind === "tool") {
          previews.push(text)
        }
      }
    })
    expect(previews).toEqual(["read {\"path\":\"x\"}"])
  })

  test("throws when the factory yields no usable session", async () => {
    const engine = new LoopEngine(factoryFor(() => ({ session: undefined })), () => undefined)
    await expect(engine.run({ label: "ag", systemPrompt: "p", prompt: "go", cwd: "/x", childDepth: 1, maxTokens: 0 })).rejects.toThrow("ag: failed to create an in-process subagent session")
  })
})

const DEFINITION: AgentDefinition = {
  name: "coder",
  description: "writes code",
  model: "inherit",
  tools: "all",
  thinking: "",
  prompt: "You are coder.",
  source: "coder.md"
}

function runnerWith(engineFactory: SessionFactory, getAllTools: () => unknown, sink: { sendMessage: (m: Record<string, unknown>, o: Record<string, unknown>) => void }, config = CONFIG): Runner {
  const engine = new LoopEngine(engineFactory, () => undefined)

  return new Runner(engine, { getAllTools }, sink, config, 0)
}

describe("Runner.resolveToolScope", () => {
  test("returns no tools for an all-scope definition", () => {
    const runner = runnerWith(factoryFor(() => ({ session: new FakeSession(async () => undefined) })), () => [], { sendMessage: () => undefined })
    expect(runner.resolveToolScope(DEFINITION)).toEqual({ dropped: [] })
  })

  test("filters to available tools and records dropped ones", () => {
    const runner = runnerWith(factoryFor(() => ({ session: new FakeSession(async () => undefined) })), () => ["custom"], { sendMessage: () => undefined })
    const scope = runner.resolveToolScope({ ...DEFINITION, tools: ["read", "custom", "imaginary"] })
    expect(scope.tools).toEqual(["read", "custom"])
    expect(scope.dropped).toEqual(["imaginary"])
  })

  test("treats builtin tools as always available", () => {
    const runner = runnerWith(factoryFor(() => ({ session: new FakeSession(async () => undefined) })), () => [], { sendMessage: () => undefined })
    const scope = runner.resolveToolScope({ ...DEFINITION, tools: BUILTIN_TOOLS })
    expect(scope.tools).toEqual(BUILTIN_TOOLS)
    expect(scope.dropped).toEqual([])
  })

  test("throws when no requested tools survive", () => {
    const runner = runnerWith(factoryFor(() => ({ session: new FakeSession(async () => undefined) })), () => [], { sendMessage: () => undefined })
    expect(() => runner.resolveToolScope({ ...DEFINITION, tools: ["nope"] })).toThrow("requested tools [nope] but none of them are available")
  })
})

describe("Runner.ensureDepth", () => {
  test("throws when the runner is at or above the depth cap", () => {
    const engine = new LoopEngine(factoryFor(() => ({ session: new FakeSession(async () => undefined) })), () => undefined)
    const deep = new Runner(engine, { getAllTools: () => [] }, { sendMessage: () => undefined }, CONFIG, 2)
    expect(() => deep.ensureDepth()).toThrow("task depth limit of 2 reached (current depth 2)")
  })

  test("allows delegation below the cap", () => {
    const runner = runnerWith(factoryFor(() => ({ session: new FakeSession(async () => undefined) })), () => [], { sendMessage: () => undefined })
    expect(() => runner.ensureDepth()).not.toThrow()
  })
})

describe("Runner.runAgent", () => {
  test("records a task and returns an outcome including the system prompt yield instruction", async () => {
    let seenPrompt = ""
    const factory = factoryFor((options) => {
      seenPrompt = options.systemPrompt

      return {
        session: new FakeSession(async (s) => {
          s.emit({ type: "turn_end" })
          s.messages = [assistantMessage("the result", 50)]
        })
      }
    })
    const runner = runnerWith(factory, () => [], { sendMessage: () => undefined })
    const outcome = await runner.runAgent(DEFINITION, "do it", undefined, { cwd: "/x", model: { id: "m" }, roles: noRoles() }, undefined)
    expect(outcome.text).toBe("the result")
    expect(outcome.turns).toBe(1)
    expect(outcome.model).toBe("m")
    expect(seenPrompt.endsWith(YIELD_INSTRUCTION)).toBe(true)
    const tasks = runner.listTasks()
    expect(tasks.length).toBe(1)
    expect(tasks[0].state).toBe("done")
    expect(tasks[0].turns).toBe(1)
  })

  test("marks a task aborted when the parent signal fires", async () => {
    const controller = new AbortController()
    const factory = factoryFor(() => ({
      session: new FakeSession(async (s) => {
        controller.abort()
        s.messages = [assistantMessage("ignored")]
      })
    }))
    const runner = runnerWith(factory, () => [], { sendMessage: () => undefined })
    await expect(runner.runAgent(DEFINITION, "do", undefined, { cwd: "/x", roles: noRoles() }, controller.signal)).rejects.toThrow("coder: aborted")
    expect(runner.listTasks()[0].state).toBe("aborted")
  })

  test("includes context as a wrapped block in the prompt", async () => {
    let prompt = ""
    const factory = factoryFor(() => ({
      session: new FakeSession(async (s) => {
        s.messages = [assistantMessage("x")]
      })
    }))
    const engine = new LoopEngine({
      async createSession(options) {
        prompt = options.systemPrompt

        return factory.createSession(options)
      }
    }, () => undefined)
    const runner = new Runner(engine, { getAllTools: () => [] }, { sendMessage: () => undefined }, CONFIG, 0)
    await runner.runAgent(DEFINITION, "task", "extra background", { cwd: "/x", roles: noRoles() }, undefined)
    expect(prompt.endsWith(YIELD_INSTRUCTION)).toBe(true)
  })
})

describe("Runner task bookkeeping", () => {
  test("evicts oldest finished tasks beyond keepFinished", async () => {
    const config: SubagentsConfig = { ...CONFIG, keepFinished: 1 }
    const factory = factoryFor(() => ({
      session: new FakeSession(async (s) => {
        s.messages = [assistantMessage("ok")]
      })
    }))
    const runner = runnerWith(factory, () => [], { sendMessage: () => undefined }, config)
    await runner.runAgent(DEFINITION, "a", undefined, { cwd: "/x", roles: noRoles() }, undefined)
    await new Promise((resolve) => setTimeout(resolve, 2))
    await runner.runAgent(DEFINITION, "b", undefined, { cwd: "/x", roles: noRoles() }, undefined)
    await new Promise((resolve) => setTimeout(resolve, 2))
    await runner.runAgent(DEFINITION, "c", undefined, { cwd: "/x", roles: noRoles() }, undefined)
    await new Promise((resolve) => setTimeout(resolve, 2))
    await runner.runAgent(DEFINITION, "d", undefined, { cwd: "/x", roles: noRoles() }, undefined)
    const remaining = runner.listTasks()
    expect(remaining.length).toBe(2)
    expect(remaining.every((task) => task.state === "done")).toBe(true)
  })

  test("killTask reports missing for unknown ids", () => {
    const runner = runnerWith(factoryFor(() => ({ session: new FakeSession(async () => undefined) })), () => [], { sendMessage: () => undefined })
    expect(runner.killTask("nope")).toBe("missing")
  })
})

describe("Runner background delivery", () => {
  function deliveryCtx(entries: unknown[], idle: boolean): DeliveryContext {
    return {
      hasUI: true,
      isIdle: () => idle,
      ui: { notify: () => undefined },
      sessionManager: { getEntries: () => entries }
    }
  }

  test("delivers a completed background job and dedups via session entries", async () => {
    const sent: Array<Record<string, unknown>> = []
    const entries: unknown[] = []
    const factory = factoryFor(() => ({
      session: new FakeSession(async (s) => {
        s.messages = [assistantMessage("bg result")]
      })
    }))
    const runner = runnerWith(factory, () => [], {
      sendMessage: (message) => {
        sent.push(message)
        const details = message.details as Record<string, unknown>
        entries.push({ type: "custom_message", customType: "subagents:result", details: { deliveryKey: details.deliveryKey } })
      }
    })
    runner.noteContext(deliveryCtx(entries, true))
    runner.startJob("coder", async (signal) => {
      const outcome = await runner.runAgent(DEFINITION, "bg", undefined, { cwd: "/x", roles: noRoles() }, signal, undefined, "background")

      return { text: outcome.text, details: { agent: outcome.agent } }
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent.length).toBe(1)
    const message = sent[0]
    expect(message.customType).toBe("subagents:result")
    expect(message.display).toBe(true)
    const details = message.details as Record<string, unknown>
    expect(typeof details.deliveryKey).toBe("string")
    expect(details.status).toBe("completed")
    expect(String(message.content)).toContain("background job")
    runner.stopDeliveries()
  })

  test("sends once and clears the outbox when there is no context", async () => {
    const sent: Array<Record<string, unknown>> = []
    const factory = factoryFor(() => ({
      session: new FakeSession(async (s) => {
        s.messages = [assistantMessage("x")]
      })
    }))
    const runner = runnerWith(factory, () => [], { sendMessage: (m) => sent.push(m) })
    runner.startJob("coder", async () => ({ text: "done", details: {} }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent.length).toBe(1)
    runner.stopDeliveries()
  })
})
