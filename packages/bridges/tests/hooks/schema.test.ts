import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  EVENT_MAPPING,
  HOOK_EVENTS,
  HookLoader,
  type LoadedHooks,
} from "../../src/hooks/schema.ts"

function fresh(): LoadedHooks {
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

describe("event tables", () => {
  test("HOOK_EVENTS order is exact", () => {
    expect([...HOOK_EVENTS]).toEqual([
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "SessionStart",
      "Stop",
      "PreCompact",
      "SessionEnd",
    ])
  })

  test("EVENT_MAPPING maps each Claude event to its pi event", () => {
    expect(EVENT_MAPPING).toEqual({
      PreToolUse: "tool_call",
      PostToolUse: "tool_result",
      UserPromptSubmit: "input",
      SessionStart: "session_start",
      Stop: "agent_end",
      PreCompact: "session_before_compact",
      SessionEnd: "session_shutdown",
    })
  })
})

describe("parseGroup", () => {
  const loader = new HookLoader()

  test("absent, empty, or star matcher yields a null matcher matching everything", () => {
    const problems: string[] = []
    const g1 = loader.parseGroup({ hooks: [{ type: "command", command: "x" }] }, "L", "s", 60000, problems)
    const g2 = loader.parseGroup({ matcher: "", hooks: [{ type: "command", command: "x" }] }, "L", "s", 60000, problems)
    const g3 = loader.parseGroup({ matcher: "*", hooks: [{ type: "command", command: "x" }] }, "L", "s", 60000, problems)
    expect(g1?.matcher).toBeNull()
    expect(g2?.matcher).toBeNull()
    expect(g3?.matcher).toBeNull()
    expect(g3?.matcherSource).toBe("*")
    expect(problems).toEqual([])
  })

  test("real matcher compiles to RegExp", () => {
    const problems: string[] = []
    const group = loader.parseGroup({ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }, "L", "s", 60000, problems)
    expect(group?.matcher).toBeInstanceOf(RegExp)
    expect(group?.matcher?.test("Bash")).toBe(true)
    expect(group?.matcher?.test("Edit")).toBe(false)
  })

  test("invalid regex records a problem and drops the group", () => {
    const problems: string[] = []
    const group = loader.parseGroup({ matcher: "(", hooks: [{ type: "command", command: "x" }] }, "L", "s", 60000, problems)
    expect(group).toBeNull()
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('invalid matcher regex "("')
  })

  test("non-string matcher records a problem", () => {
    const problems: string[] = []
    const group = loader.parseGroup({ matcher: 5, hooks: [{ type: "command", command: "x" }] }, "L", "s", 60000, problems)
    expect(group).toBeNull()
    expect(problems).toEqual(["L: matcher must be a string"])
  })

  test("non-object entry recorded", () => {
    const problems: string[] = []
    expect(loader.parseGroup(7, "L", "s", 60000, problems)).toBeNull()
    expect(problems).toEqual(["L: matcher group must be an object"])
  })

  test("hooks must be an array", () => {
    const problems: string[] = []
    expect(loader.parseGroup({ hooks: "x" }, "L", "s", 60000, problems)).toBeNull()
    expect(problems).toEqual(["L: hooks must be an array"])
  })

  test("type must be command", () => {
    const problems: string[] = []
    const group = loader.parseGroup({ hooks: [{ type: "exec", command: "x" }] }, "L", "s", 60000, problems)
    expect(group).toBeNull()
    expect(problems).toEqual(['L.hooks[0]: type must be "command"'])
  })

  test("empty command recorded", () => {
    const problems: string[] = []
    const group = loader.parseGroup({ hooks: [{ type: "command", command: "  " }] }, "L", "s", 60000, problems)
    expect(group).toBeNull()
    expect(problems).toEqual(["L.hooks[0]: command must be a non-empty string"])
  })

  test("timeout interpreted in seconds and rounded", () => {
    const problems: string[] = []
    const group = loader.parseGroup({ hooks: [{ type: "command", command: "x", timeout: 1.5 }] }, "L", "s", 60000, problems)
    expect(group?.hooks[0].timeoutMs).toBe(1500)
    expect(problems).toEqual([])
  })

  test("invalid timeout falls back to default with a problem", () => {
    const problems: string[] = []
    const group = loader.parseGroup({ hooks: [{ type: "command", command: "x", timeout: -2 }] }, "L", "s", 60000, problems)
    expect(group?.hooks[0].timeoutMs).toBe(60000)
    expect(problems).toEqual(["L.hooks[0]: timeout must be a positive number of seconds; using the default"])
  })

  test("group with no valid hooks returns null", () => {
    const problems: string[] = []
    const group = loader.parseGroup({ hooks: [] }, "L", "s", 60000, problems)
    expect(group).toBeNull()
  })
})

describe("mergeFile", () => {
  const loader = new HookLoader()

  test("accepts {hooks:{...}} form", () => {
    const loaded = fresh()
    loader.mergeFile(loaded, { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }] } }, "p", 60000)
    expect(loaded.events.PreToolUse.length).toBe(1)
    expect(loaded.totalHooks).toBe(1)
  })

  test("accepts bare event-name map when hooks key absent", () => {
    const loaded = fresh()
    loader.mergeFile(loaded, { PostToolUse: [{ hooks: [{ type: "command", command: "x" }] }] }, "p", 60000)
    expect(loaded.events.PostToolUse.length).toBe(1)
    expect(loaded.totalHooks).toBe(1)
  })

  test("non-object top-level recorded", () => {
    const loaded = fresh()
    loader.mergeFile(loaded, [1, 2], "p", 60000)
    expect(loaded.problems).toEqual(["p: top level must be a JSON object"])
  })

  test("missing hooks object recorded when no event key present", () => {
    const loaded = fresh()
    loader.mergeFile(loaded, { other: 1 }, "p", 60000)
    expect(loaded.problems).toEqual(['p: missing "hooks" object'])
  })

  test("unsupported event recorded", () => {
    const loaded = fresh()
    loader.mergeFile(loaded, { hooks: { NotAnEvent: [] } }, "p", 60000)
    expect(loaded.problems.length).toBe(1)
    expect(loaded.problems[0]).toContain('unsupported event "NotAnEvent"')
  })

  test("non-array event value recorded", () => {
    const loaded = fresh()
    loader.mergeFile(loaded, { hooks: { Stop: "x" } }, "p", 60000)
    expect(loaded.problems).toEqual(["p: Stop must be an array of matcher groups"])
  })
})

describe("load from files", () => {
  let home: string
  let cwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hookshome"))
    cwd = mkdtempSync(join(tmpdir(), "hookscwd"))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  test("paths returns home first then project", () => {
    const loader = new HookLoader()
    const paths = loader.paths("/proj")
    expect(paths.length).toBe(2)
    expect(paths[0].endsWith(join(".pi", "agent", "hooks.json"))).toBe(true)
    expect(paths[1]).toBe(join("/proj", ".pi", "hooks.json"))
  })

  test("missing files silently skipped", () => {
    const loader = new HookLoader()
    const loaded = loader.load(cwd, 60000)
    expect(loaded.sources).toEqual([])
    expect(loaded.problems).toEqual([])
    expect(loaded.totalHooks).toBe(0)
  })

  test("invalid JSON recorded as a problem", () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true })
    writeFileSync(join(cwd, ".pi", "hooks.json"), "{not json")
    const loader = new HookLoader()
    const loaded = loader.load(cwd, 60000)
    expect(loaded.problems.length).toBe(1)
    expect(loaded.problems[0]).toContain("invalid JSON")
    expect(loaded.sources).toEqual([])
  })

  test("project file is loaded and counted as a source", () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true })
    writeFileSync(
      join(cwd, ".pi", "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } }),
    )
    const loader = new HookLoader()
    const loaded = loader.load(cwd, 60000)
    expect(loaded.sources).toEqual([join(cwd, ".pi", "hooks.json")])
    expect(loaded.totalHooks).toBe(1)
    expect(loaded.events.PreToolUse[0].matcherSource).toBe("Bash")
  })
})
