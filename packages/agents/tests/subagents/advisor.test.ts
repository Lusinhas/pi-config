import { describe, expect, test } from "bun:test"
import {
  Advisor,
  ADVISOR_PROMPT,
  buildTranscript,
  clip,
  readEntries,
  renderBlock,
  renderContent
} from "../../src/subagents/advisor.ts"
import { LoopEngine } from "../../src/subagents/engine.ts"
import { RouterRoles } from "../../src/subagents/model.ts"
import type { CreatedSession, SessionCreateOptions, SessionFactory, SessionLike } from "../../src/subagents/engine.ts"
import type { SubagentsConfig } from "../../src/subagents/config.ts"

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

class ScriptedSession implements SessionLike {
  messages: unknown[]

  constructor(finalText: string) {
    this.messages = finalText === "" ? [] : [{ role: "assistant", content: [{ type: "text", text: finalText }], usage: { totalTokens: 10 } }]
  }

  subscribe(): () => void {
    return () => undefined
  }

  async prompt(): Promise<void> {}
}

function captureFactory(finalText: string, capture: (options: SessionCreateOptions) => void): SessionFactory {
  return {
    async createSession(options: SessionCreateOptions): Promise<CreatedSession> {
      capture(options)

      return { session: new ScriptedSession(finalText) }
    }
  }
}

describe("clip", () => {
  test("returns short text untouched", () => {
    expect(clip("hello", 100)).toBe("hello")
  })

  test("truncates and appends the count", () => {
    expect(clip("abcdef", 3)).toBe("abc [+3 chars truncated]")
  })
})

describe("renderBlock", () => {
  test("renders text blocks and drops thinking blocks", () => {
    expect(renderBlock({ type: "text", text: "hi" })).toBe("hi")
    expect(renderBlock({ type: "thinking", text: "secret" })).toBe("")
  })

  test("renders tool calls with clipped arguments", () => {
    const out = renderBlock({ type: "toolCall", name: "read", input: { path: "x" } })
    expect(out).toContain("[tool call: read")
    expect(out).toContain("\"path\":\"x\"")
  })

  test("renders tool results with clipped content", () => {
    expect(renderBlock({ type: "tool_result", content: "result body" })).toBe("[tool result: result body]")
  })

  test("renders images and ignores unknown blocks", () => {
    expect(renderBlock({ type: "image" })).toBe("[image]")
    expect(renderBlock({ type: "weird" })).toBe("")
  })
})

describe("renderContent", () => {
  test("returns plain strings", () => {
    expect(renderContent("text")).toBe("text")
  })

  test("joins non-empty blocks", () => {
    expect(renderContent([{ type: "text", text: "a" }, { type: "thinking" }, { type: "text", text: "b" }])).toBe("a\nb")
  })
})

describe("buildTranscript", () => {
  test("labels roles and skips empty and custom entries", () => {
    const entries = [
      { type: "custom" },
      { message: { role: "user", content: "hello" } },
      { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
      { message: { role: "tool", content: "tool output" } },
      { message: { role: "assistant", content: [{ type: "thinking" }] } }
    ]
    const transcript = buildTranscript(entries, 10000)
    expect(transcript).toContain("### User\nhello")
    expect(transcript).toContain("### Assistant\nhi")
    expect(transcript).toContain("### Tool\ntool output")
    expect(transcript).not.toContain("thinking")
  })

  test("truncates to the most recent characters", () => {
    const big = "x".repeat(500)
    const entries = [{ message: { role: "user", content: big } }]
    const transcript = buildTranscript(entries, 100)
    expect(transcript.startsWith("[transcript truncated to the most recent 100 characters]")).toBe(true)
  })

  test("reads flat role-bearing entries", () => {
    const transcript = buildTranscript([{ role: "user", content: "direct" }], 10000)
    expect(transcript).toContain("### User\ndirect")
  })
})

describe("readEntries", () => {
  test("prefers getBranch then getEntries", () => {
    expect(readEntries({ getBranch: () => ["b"], getEntries: () => ["e"] })).toEqual(["b"])
    expect(readEntries({ getEntries: () => ["e"] })).toEqual(["e"])
  })

  test("returns an empty array for non-records", () => {
    expect(readEntries(null)).toEqual([])
    expect(readEntries(5)).toEqual([])
  })
})

describe("Advisor.run", () => {
  test("requires a non-empty question", async () => {
    const engine = new LoopEngine(captureFactory("advice", () => undefined), () => undefined)
    const advisor = new Advisor(engine, 0)
    await expect(advisor.run("   ", CONFIG, { cwd: "/x", roles: noRoles() }, undefined)).rejects.toThrow("advisor: a question is required")
  })

  test("runs with the advisor prompt and no tools", async () => {
    let options: SessionCreateOptions | undefined
    const engine = new LoopEngine(captureFactory("here is my advice", (opts) => {
      options = opts
    }), () => undefined)
    const advisor = new Advisor(engine, 0)
    const result = await advisor.run("is this sound?", CONFIG, { cwd: "/x", model: { id: "m" }, sessionManager: { getEntries: () => [] }, roles: noRoles() }, undefined)
    expect(result.text).toBe("here is my advice")
    expect(options?.systemPrompt).toBe(ADVISOR_PROMPT)
    expect(options?.tools).toEqual([])
    expect(result.details.thinking).toBe("xhigh")
    expect(result.details.turns).toBe(0)
    expect(result.details.transcriptChars).toBe(0)
  })

  test("falls back to xhigh for an invalid configured thinking level", async () => {
    const engine = new LoopEngine(captureFactory("ok", () => undefined), () => undefined)
    const advisor = new Advisor(engine, 0)
    const result = await advisor.run("q", { ...CONFIG, advisorThinking: "ultra" }, { cwd: "/x", roles: noRoles() }, undefined)
    expect(result.details.thinking).toBe("xhigh")
  })

  test("honors a valid configured thinking level", async () => {
    const engine = new LoopEngine(captureFactory("ok", () => undefined), () => undefined)
    const advisor = new Advisor(engine, 0)
    const result = await advisor.run("q", { ...CONFIG, advisorThinking: "low" }, { cwd: "/x", roles: noRoles() }, undefined)
    expect(result.details.thinking).toBe("low")
  })

  test("throws when the advisor returns no advice", async () => {
    const engine = new LoopEngine(captureFactory("", () => undefined), () => undefined)
    const advisor = new Advisor(engine, 0)
    await expect(advisor.run("q", CONFIG, { cwd: "/x", roles: noRoles() }, undefined)).rejects.toThrow("advisor: the advisor model returned no advice")
  })
})
