import { describe, expect, test } from "bun:test"
import { Sandbox } from "../../src/workflows/sandbox.ts"
import type { ScriptGlobals } from "../../src/workflows/sandbox.ts"

function makeGlobals(logs: string[]): ScriptGlobals {
  return {
    agent: async () => null,
    parallel: async () => [],
    pipeline: async () => [],
    phase: () => {},
    log: (message: unknown) => logs.push(String(message)),
    args: { value: 7 },
    budget: { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY }
  }
}

function run(body: string, logs: string[] = [], timeoutMs = 5000): { promise: Promise<unknown>; controller: AbortController } {
  const controller = new AbortController()
  const sandbox = new Sandbox()
  const promise = sandbox.execute({ body, globals: makeGlobals(logs), controller, timeoutMs })

  return { promise, controller }
}

describe("Sandbox.execute", () => {
  test("returns the script value", async () => {
    const { promise } = run("return 1 + 2")

    expect(await promise).toBe(3)
  })

  test("top-level await works", async () => {
    const { promise } = run("const x = await Promise.resolve(10); return x * 2")

    expect(await promise).toBe(20)
  })

  test("args global is exposed", async () => {
    const { promise } = run("return args.value")

    expect(await promise).toBe(7)
  })

  test("budget global is exposed", async () => {
    const { promise } = run("return budget.remaining()")

    expect(await promise).toBe(Number.POSITIVE_INFINITY)
  })

  test("console routes through log with prefixes", async () => {
    const logs: string[] = []
    const { promise } = run("console.log('hello', {a:1}); console.warn('careful'); console.error('boom'); return 0", logs)
    await promise

    expect(logs).toEqual(["hello {\"a\":1}", "[warn] careful", "[error] boom"])
  })

  test("Math.random is blocked", async () => {
    const { promise } = run("return Math.random()")

    await expect(promise).rejects.toThrow("workflow: Math.random() is blocked")
  })

  test("Math non-random still works", async () => {
    const { promise } = run("return Math.max(1, 9, 4)")

    expect(await promise).toBe(9)
  })

  test("Date.now is blocked", async () => {
    const { promise } = run("return Date.now()")

    await expect(promise).rejects.toThrow("workflow: Date.now() is blocked")
  })

  test("argless new Date is blocked but timestamped is allowed", async () => {
    const blocked = run("return new Date()")
    await expect(blocked.promise).rejects.toThrow("new Date() with no arguments is blocked")

    const allowed = run("return new Date(0).getTime()")
    expect(await allowed.promise).toBe(0)
  })

  test("Date() call form is blocked", async () => {
    const { promise } = run("return Date()")

    await expect(promise).rejects.toThrow("workflow: Date() is blocked")
  })

  test("wall-clock timeout aborts with descriptive message", async () => {
    const { promise } = run("await new Promise(() => {}); return 1", [], 50)

    await expect(promise).rejects.toThrow(/exceeded the \d+s wall-clock limit/)
  })

  test("external abort rejects with run aborted", async () => {
    const { promise, controller } = run("await new Promise(() => {}); return 1", [], 10000)
    setTimeout(() => controller.abort(), 20)

    await expect(promise).rejects.toThrow("workflow: run aborted")
  })

  test("abort with custom error reason surfaces that error", async () => {
    const { promise, controller } = run("await new Promise(() => {}); return 1", [], 10000)
    const reason = new Error("custom cap reached")
    setTimeout(() => controller.abort(reason), 20)

    await expect(promise).rejects.toThrow("custom cap reached")
  })

  test("already-aborted controller rejects immediately", async () => {
    const controller = new AbortController()
    controller.abort()
    const sandbox = new Sandbox()
    const promise = sandbox.execute({ body: "return 1", globals: makeGlobals([]), controller, timeoutMs: 5000 })

    await expect(promise).rejects.toThrow("workflow: run aborted")
  })

  test("eval is disabled by code generation block", async () => {
    const { promise } = run("return eval('1+1')")

    await expect(promise).rejects.toThrow()
  })

  test("renderPart serializes values", () => {
    expect(Sandbox.renderPart("x")).toBe("x")
    expect(Sandbox.renderPart({ a: 1 })).toBe("{\"a\":1}")
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(typeof Sandbox.renderPart(circular)).toBe("string")
  })
})
