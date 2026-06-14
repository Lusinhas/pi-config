import { describe, expect, test } from "bun:test"
import { ViewerRenderer } from "../../src/workflows/render.ts"
import type { RunRecord } from "../../src/workflows/types.ts"

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "wf_abc",
    name: "demo",
    state: "running",
    phases: [],
    logs: [],
    agentCount: 0,
    tokens: 0,
    startedAt: 0,
    ...overrides
  }
}

describe("ViewerRenderer", () => {
  test("glyph maps each state to mark and color", () => {
    expect(ViewerRenderer.glyph("running")).toEqual({ mark: "▶", color: "accent" })
    expect(ViewerRenderer.glyph("done")).toEqual({ mark: "✓", color: "success" })
    expect(ViewerRenderer.glyph("aborted")).toEqual({ mark: "■", color: "warning" })
    expect(ViewerRenderer.glyph("failed")).toEqual({ mark: "✗", color: "error" })
  })

  test("elapsed formats seconds, minutes, hours", () => {
    expect(ViewerRenderer.elapsed(record({ startedAt: 0, endedAt: 30000 }), 0)).toBe("30s")
    expect(ViewerRenderer.elapsed(record({ startedAt: 0, endedAt: 95000 }), 0)).toBe("1m35s")
    expect(ViewerRenderer.elapsed(record({ startedAt: 0, endedAt: 3_725_000 }), 0)).toBe("1h2m")
  })

  test("elapsed uses now when not ended", () => {
    expect(ViewerRenderer.elapsed(record({ startedAt: 1000 }), 6000)).toBe("5s")
  })

  test("phaseSummary excludes zero-agent phases", () => {
    const r = record({ phases: [{ title: "scan", agents: 2 }, { title: "idle", agents: 0 }, { title: "build", agents: 1 }] })

    expect(ViewerRenderer.phaseSummary(r)).toBe("scan(2) build(1)")
  })

  test("runLine includes background and phases", () => {
    const r = record({ id: "wf_x", name: "n", agentCount: 3, tokens: 42, startedAt: 0, endedAt: 5000, background: true, phases: [{ title: "scan", agents: 1 }] })

    expect(ViewerRenderer.runLine(r, 0)).toBe("n wf_x · 3 agents · 42 tokens · 5s · background · scan(1)")
  })

  test("runLine without phases or background", () => {
    const r = record({ id: "wf_y", name: "m", agentCount: 1, tokens: 5, startedAt: 0, endedAt: 1000 })

    expect(ViewerRenderer.runLine(r, 0)).toBe("m wf_y · 1 agents · 5 tokens · 1s")
  })

  test("paint returns raw text without theme", () => {
    expect(ViewerRenderer.paint(undefined, "accent", "hi")).toBe("hi")
  })

  test("paint uses theme.fg when present", () => {
    const theme = { fg: (_color: never, text: string) => `[${text}]` }
    expect(ViewerRenderer.paint(theme, "accent", "hi")).toBe("[hi]")
  })

  test("paint falls back to raw text when fg throws", () => {
    const theme = { fg: () => { throw new Error("boom") } }
    expect(ViewerRenderer.paint(theme, "accent", "hi")).toBe("hi")
  })
})
