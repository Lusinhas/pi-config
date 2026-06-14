import { afterEach, describe, expect, test } from "bun:test"
import {
  MonitorManager,
  type MonitorMessage,
  type MonitorOptions,
} from "../../src/hooks/monitors.ts"

const baseOptions: Omit<MonitorOptions, "specs"> = {
  backoffInitialMs: 20,
  backoffMaxMs: 200,
  backoffResetAfterMs: 1000,
  killGraceMs: 50,
  maxLineLength: 20,
}

async function until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met within " + timeoutMs + "ms")
    }

    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const managers: MonitorManager[] = []

function build(specs: MonitorOptions["specs"], sink: MonitorMessage[]): MonitorManager {
  const manager = new MonitorManager(
    (message) => {
      sink.push(message)
    },
    { ...baseOptions, specs },
    process.cwd(),
  )
  managers.push(manager)
  return manager
}

afterEach(() => {
  while (managers.length > 0) {
    const manager = managers.pop()

    if (manager) {
      manager.stop()
    }
  }
})

describe("MonitorManager statuses", () => {
  test("no specs yields empty statuses", () => {
    const manager = build([], [])
    expect(manager.statuses()).toEqual([])
  })

  test("initial state is stopped", () => {
    const manager = build([{ name: "a", command: "true", when: "always" }], [])
    const status = manager.statuses()[0]
    expect(status.name).toBe("a")
    expect(status.state).toBe("stopped")
    expect(status.pid).toBeNull()
    expect(status.restarts).toBe(0)
  })
})

describe("MonitorManager forwarding", () => {
  test("stdout lines forwarded with monitor prefix", async () => {
    const sink: MonitorMessage[] = []
    const manager = build([{ name: "log", command: "printf 'hello\\nworld\\n'", when: "always" }], sink)
    manager.start(process.cwd())
    await until(() => sink.length >= 2)
    expect(sink[0]).toEqual({ customType: "monitor", content: "[monitor:log] hello", display: false })
    expect(sink[1].content).toBe("[monitor:log] world")
  })

  test("blank lines are skipped", async () => {
    const sink: MonitorMessage[] = []
    const manager = build([{ name: "log", command: "printf '\\n   \\nkept\\n'", when: "always" }], sink)
    manager.start(process.cwd())
    await until(() => sink.some((m) => m.content.includes("kept")))
    expect(sink.every((m) => m.content.includes("kept"))).toBe(true)
  })

  test("long lines truncated with marker", async () => {
    const sink: MonitorMessage[] = []
    const long = "x".repeat(50)
    const manager = build([{ name: "log", command: "printf '" + long + "\\n'", when: "always" }], sink)
    manager.start(process.cwd())
    await until(() => sink.length >= 1)
    expect(sink[0].content).toBe("[monitor:log] " + "x".repeat(20) + " [truncated]")
  })

  test("trailing line without newline flushed on exit", async () => {
    const sink: MonitorMessage[] = []
    const manager = build([{ name: "log", command: "printf 'tail'", when: "always" }], sink)
    manager.start(process.cwd())
    await until(() => sink.some((m) => m.content === "[monitor:log] tail"))
    expect(sink.some((m) => m.content === "[monitor:log] tail")).toBe(true)
  })

  test("running monitor reports a pid and running state", async () => {
    const sink: MonitorMessage[] = []
    const manager = build([{ name: "loop", command: "sleep 5", when: "always" }], sink)
    manager.start(process.cwd())
    await until(() => manager.statuses()[0].state === "running")
    const status = manager.statuses()[0]
    expect(status.state).toBe("running")
    expect(typeof status.pid).toBe("number")
  })

  test("stop terminates a running monitor", async () => {
    const sink: MonitorMessage[] = []
    const manager = build([{ name: "loop", command: "sleep 5", when: "always" }], sink)
    manager.start(process.cwd())
    await until(() => manager.statuses()[0].state === "running")
    manager.stop()
    await until(() => manager.statuses()[0].pid === null)
    expect(manager.statuses()[0].pid).toBeNull()
  })

  test("exiting monitor restarts and increments counter", async () => {
    const sink: MonitorMessage[] = []
    const manager = build([{ name: "quick", command: "true", when: "always" }], sink)
    manager.start(process.cwd())
    await until(() => manager.statuses()[0].restarts >= 2)
    expect(manager.statuses()[0].restarts).toBeGreaterThanOrEqual(2)
  })
})
