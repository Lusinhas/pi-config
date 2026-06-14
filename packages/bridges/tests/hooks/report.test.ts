import { describe, expect, test } from "bun:test"
import { History, type HooksConfig } from "../../src/hooks/index.ts"
import type { MonitorStatus } from "../../src/hooks/monitors.ts"
import { Reporter } from "../../src/hooks/report.ts"
import type { HookGroup, LoadedHooks } from "../../src/hooks/schema.ts"

const config: HooksConfig = {
  shell: "/bin/sh",
  defaultTimeoutMs: 60000,
  eventBudgetMs: 120000,
  maxOutputBytes: 16384,
  historySize: 50,
  monitorMaxLineLength: 2000,
  killGraceMs: 3000,
  backoff: { initialMs: 1000, maxMs: 30000, resetAfterMs: 30000 },
  monitors: [],
  problems: [],
}

function emptyLoaded(): LoadedHooks {
  return {
    events: {
      PreToolUse: [],
      PostToolUse: [],
      UserPromptSubmit: [],
      SessionStart: [],
      Stop: [],
      PreCompact: [],
      SessionEnd: [],
    },
    problems: [],
    sources: [],
    totalHooks: 0,
  }
}

function group(matcherSource: string, commands: string[], timeoutMs: number): HookGroup {
  return {
    matcher: matcherSource.length > 0 && matcherSource !== "*" ? new RegExp(matcherSource) : null,
    matcherSource,
    hooks: commands.map((command) => ({ command, timeoutMs, source: "p" })),
    source: "p",
  }
}

describe("buildReport", () => {
  test("empty report has expected sections and is info-level", () => {
    const report = new Reporter().buildReport(emptyLoaded(), [], new History(50), config, ["/home/a", "/proj/b"])
    expect(report.hasProblems).toBe(false)
    expect(report.text).toContain("Hook event mapping (Claude name -> pi event):")
    expect(report.text).toContain("  PreToolUse -> tool_call")
    expect(report.text).toContain("  SessionEnd -> session_shutdown")
    expect(report.text).toContain("  none found (looked for /home/a and /proj/b)")
    expect(report.text).toContain("Hooks loaded (0):")
    expect(report.text).toContain("Validation problems (0):")
    expect(report.text).toContain("Monitors (0):")
    expect(report.text).toContain("  none configured")
    expect(report.text).toContain("Recent dispatches (newest first, keeping last 50):")
    expect(report.text).toContain("  none yet")
    expect(report.text).toContain("default 60s per hook, 120s budget per event")
  })

  test("loaded hooks rendered with matcher and timeout in seconds", () => {
    const loaded = emptyLoaded()
    loaded.events.PreToolUse.push(group("Bash", ["echo hi"], 30000))
    loaded.events.Stop.push(group("", ["cleanup"], 60000))
    loaded.totalHooks = 2
    loaded.sources = ["/proj/.pi/hooks.json"]
    const report = new Reporter().buildReport(loaded, [], new History(50), config, ["/h", "/p"])
    expect(report.text).toContain("  /proj/.pi/hooks.json")
    expect(report.text).toContain("  PreToolUse:")
    expect(report.text).toContain("    [Bash] echo hi (timeout 30s)")
    expect(report.text).toContain("    [*] cleanup (timeout 60s)")
  })

  test("problems flip hasProblems and render", () => {
    const loaded = emptyLoaded()
    loaded.problems = ["p: bad"]
    const withConfigProblems = { ...config, problems: ["config: oops"] }
    const report = new Reporter().buildReport(loaded, [], new History(50), withConfigProblems, ["/h", "/p"])
    expect(report.hasProblems).toBe(true)
    expect(report.text).toContain("Validation problems (2):")
    expect(report.text).toContain("  p: bad")
    expect(report.text).toContain("  config: oops")
  })

  test("monitor status formatting", () => {
    const statuses: MonitorStatus[] = [
      { name: "log", command: "tail", state: "running", pid: 1234, restarts: 2, lastExit: "code 0", stderrTail: "warn" },
    ]
    const report = new Reporter().buildReport(emptyLoaded(), statuses, new History(50), config, ["/h", "/p"])
    expect(report.text).toContain("Monitors (1):")
    expect(report.text).toContain("  log: running pid 1234, restarts 2, last exit code 0 | stderr: warn")
  })

  test("recent dispatches newest first, last 15", () => {
    const history = new History(50)

    for (let i = 0; i < 20; i += 1) {
      history.push({
        at: "2026-06-13T12:00:" + String(i).padStart(2, "0") + ".000Z",
        event: "Stop",
        command: "cmd" + i,
        outcome: "ok",
        exitCode: i % 2 === 0 ? 0 : null,
        durationMs: i,
        detail: i === 19 ? "with detail" : "",
      })
    }

    const report = new Reporter().buildReport(emptyLoaded(), [], history, config, ["/h", "/p"])
    expect(report.text).toContain("  12:00:19 Stop ok exit - 19ms cmd19 | with detail")
    expect(report.text).toContain("  12:00:05 Stop ok exit - 5ms cmd5")
    expect(report.text).not.toContain("cmd4 ")
  })
})

describe("reloadSummary", () => {
  test("summary without problems is info-level", () => {
    const loaded = emptyLoaded()
    loaded.totalHooks = 3
    loaded.sources = ["a", "b"]
    const summary = new Reporter().reloadSummary(loaded)
    expect(summary.hasProblems).toBe(false)
    expect(summary.text).toBe("hooks reloaded: 3 hook(s) from 2 file(s)")
  })

  test("summary with problems appends count and is warning-level", () => {
    const loaded = emptyLoaded()
    loaded.totalHooks = 1
    loaded.sources = ["a"]
    loaded.problems = ["x", "y"]
    const summary = new Reporter().reloadSummary(loaded)
    expect(summary.hasProblems).toBe(true)
    expect(summary.text).toBe("hooks reloaded: 1 hook(s) from 1 file(s), 2 problem(s)")
  })
})
