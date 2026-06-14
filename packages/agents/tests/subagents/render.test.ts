import { describe, expect, test } from "bun:test"
import {
  formatElapsedSeconds,
  glyph,
  taskLine,
  taskReport,
  transcriptLines,
  ViewerModel,
  widgetLines
} from "../../src/subagents/render.ts"
import type { Painter, Truncate } from "../../src/subagents/render.ts"
import type { Runner, TaskRecord } from "../../src/subagents/index.ts"

const plain: Painter = (_color, text) => text
const noTrunc: Truncate = (text) => text

function record(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "abc123",
    agent: "coder",
    via: "",
    state: "running",
    turns: 0,
    tokens: 0,
    startedAt: 0,
    activity: "starting",
    transcript: [],
    ...overrides
  }
}

function runnerOf(tasks: TaskRecord[], killed: string[]): Runner {
  return {
    listTasks: () => tasks,
    killTask: (id: string) => {
      killed.push(id)

      return "aborted" as const
    }
  } as unknown as Runner
}

describe("formatElapsedSeconds", () => {
  test("formats seconds, minutes, and hours", () => {
    expect(formatElapsedSeconds(5)).toBe("5s")
    expect(formatElapsedSeconds(90)).toBe("1m30s")
    expect(formatElapsedSeconds(3700)).toBe("1h1m")
  })
})

describe("glyph", () => {
  test("maps each state to a mark and color", () => {
    expect(glyph("running")).toEqual({ mark: "▶", color: "accent" })
    expect(glyph("done")).toEqual({ mark: "✓", color: "success" })
    expect(glyph("aborted")).toEqual({ mark: "■", color: "warning" })
    expect(glyph("failed")).toEqual({ mark: "✗", color: "error" })
  })
})

describe("taskLine", () => {
  test("includes via and turn when present", () => {
    const line = taskLine(record({ via: "team:x", turns: 3, activity: "thinking" }), 0)
    expect(line).toBe("coder (team:x) #abc123 · turn 3 · 0s · thinking")
  })

  test("omits via and turn when absent", () => {
    const line = taskLine(record({ activity: "go" }), 0)
    expect(line).toBe("coder #abc123 · 0s · go")
  })
})

describe("widgetLines", () => {
  test("returns nothing when no tasks run", () => {
    expect(widgetLines([record({ state: "done" })], 4, plain, 0)).toEqual([])
  })

  test("limits visible running tasks and appends an overflow line", () => {
    const tasks = [
      record({ id: "1", state: "running" }),
      record({ id: "2", state: "running" }),
      record({ id: "3", state: "running" })
    ]
    const lines = widgetLines(tasks, 2, plain, 0)
    expect(lines.length).toBe(3)
    expect(lines[2]).toContain("… 1 more running (/agents view)")
  })
})

describe("taskReport", () => {
  test("reports an empty session", () => {
    expect(taskReport([])).toBe("No subagent tasks have run in this session.")
  })

  test("summarizes counts and lists each task", () => {
    const report = taskReport([record({ state: "running" }), record({ id: "x", state: "done", activity: "done" })], 0)
    expect(report).toContain("Subagent tasks (1 running, 2 total):")
    expect(report).toContain("[running]")
    expect(report).toContain("[done]")
  })
})

describe("transcriptLines", () => {
  test("renders the first 12 lines and a more-lines marker", () => {
    const body = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n")
    const lines = transcriptLines([{ at: 0, kind: "text", text: body }], plain, noTrunc, 80)
    expect(lines.some((line) => line.includes("… 3 more lines"))).toBe(true)
  })
})

describe("ViewerModel", () => {
  test("renders the list header with counts", () => {
    const model = new ViewerModel(runnerOf([record({ state: "running" }), record({ id: "y", state: "done" })], []))
    const lines = model.render(80, plain, noTrunc, 0)
    expect(lines.some((line) => line.includes("Subagent tasks — 1 running, 2 total"))).toBe(true)
    expect(lines.some((line) => line.includes("↑/↓ select · enter transcript · x kill · q close"))).toBe(true)
  })

  test("enter opens detail and escape returns to the list", () => {
    const tasks = [record({ id: "one", state: "running", turns: 2, tokens: 5, transcript: [{ at: 0, kind: "info", text: "task started" }] })]
    const model = new ViewerModel(runnerOf(tasks, []))
    expect(model.handleKey("enter")).toEqual({ close: false })
    const detail = model.render(80, plain, noTrunc, 0)
    expect(detail.some((line) => line.includes("#one [running] · 2 turns · 5 tokens"))).toBe(true)
    expect(detail.some((line) => line.includes("↑/↓ scroll · esc back · x kill · q close"))).toBe(true)
    expect(model.handleKey("escape")).toEqual({ close: false })
    expect(model.handleKey("escape")).toEqual({ close: true })
  })

  test("q closes from the list", () => {
    const model = new ViewerModel(runnerOf([record({})], []))
    expect(model.handleKey("quit")).toEqual({ close: true })
  })

  test("x returns the selected task id to kill", () => {
    const model = new ViewerModel(runnerOf([record({ id: "kill-me" })], []))
    expect(model.handleKey("kill")).toEqual({ close: false, kill: "kill-me" })
  })

  test("navigation clamps the selection index", () => {
    const tasks = [record({ id: "a" }), record({ id: "b" })]
    const model = new ViewerModel(runnerOf(tasks, []))
    model.handleKey("up")
    model.handleKey("up")
    model.handleKey("down")
    model.handleKey("down")
    model.handleKey("down")
    expect(() => model.render(80, plain, noTrunc, 0)).not.toThrow()
  })
})
