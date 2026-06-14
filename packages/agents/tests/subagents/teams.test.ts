import { describe, expect, test } from "bun:test"
import { parseTeam, TeamRunner } from "../../src/subagents/teams.ts"
import type { TeamSource } from "../../src/subagents/teams.ts"
import type { AgentDefinition, AgentRegistry } from "../../src/subagents/registry.ts"
import type { Runner, TaskOutcome } from "../../src/subagents/index.ts"

function definition(name: string): AgentDefinition {
  return { name, description: "d", model: "inherit", tools: "all", thinking: "", prompt: "p", source: `${name}.md` }
}

function registryOf(...names: string[]): AgentRegistry {
  const agents = new Map<string, AgentDefinition>()

  for (const name of names) {
    agents.set(name, definition(name))
  }

  return { agents, errors: [], paths: [] }
}

interface FakeOutcomes {
  [agent: string]: TaskOutcome | Error
}

function fakeRunner(outcomes: FakeOutcomes): Runner {
  const runner = {
    depth: 0,
    async withSlot<T>(fn: () => Promise<T>): Promise<T> {
      return fn()
    },
    async runAgent(def: AgentDefinition, _task: string, _context: string | undefined, _source: unknown, _signal: unknown, onTurn?: (turns: number) => void): Promise<TaskOutcome> {
      onTurn?.(1)
      const result = outcomes[def.name]

      if (result instanceof Error) {
        throw result
      }

      if (!result) {
        throw new Error(`no fake outcome for ${def.name}`)
      }

      return result
    }
  }

  return runner as unknown as Runner
}

const SOURCE: TeamSource = { cwd: "/x" }

describe("parseTeam", () => {
  test("accepts an array of member names", () => {
    expect(parseTeam(["a", "b", "a"])).toEqual({ members: ["a", "b"], brief: "" })
  })

  test("accepts an object with members and brief", () => {
    expect(parseTeam({ members: ["a"], brief: " hello " })).toEqual({ members: ["a"], brief: "hello" })
  })

  test("rejects an empty array", () => {
    expect(parseTeam([])).toBe("team has no members")
  })

  test("rejects an object with no members", () => {
    expect(parseTeam({ members: [] })).toContain("team has no members")
  })

  test("rejects non-array, non-object values", () => {
    expect(parseTeam("x")).toContain("must be an array of agent names")
    expect(parseTeam(5)).toContain("must be an array of agent names")
  })
})

describe("TeamRunner.run", () => {
  function outcome(agent: string, text: string, turns: number, capped: TaskOutcome["capped"] = false): TaskOutcome {
    return { agent, model: "m", text, turns, tokens: 0, capped, dropped: [] }
  }

  test("merges completed members in team order", async () => {
    const runner = fakeRunner({
      a: outcome("a", "alpha result", 2),
      b: outcome("b", "beta result", 1)
    })
    const team = new TeamRunner(runner)
    const result = await team.run(registryOf("a", "b"), "squad", ["b", "a"], "do work", undefined, SOURCE, undefined)
    expect(result.text).toContain("# Team squad report (2/2 members completed)")
    const aIndex = result.text.indexOf("## a")
    const bIndex = result.text.indexOf("## b")
    expect(bIndex).toBeLessThan(aIndex)
    expect(result.text).toContain("completed in 2 turns")
    expect(result.text).toContain("completed in 1 turn")
    const members = result.details.members as Array<Record<string, unknown>>
    expect(members.map((m) => m.agent)).toEqual(["b", "a"])
  })

  test("reports capped members with the cap heading", async () => {
    const runner = fakeRunner({ a: outcome("a", "partial", 32, "tokens") })
    const team = new TeamRunner(runner)
    const result = await team.run(registryOf("a"), "squad", ["a"], "do", undefined, SOURCE, undefined)
    expect(result.text).toContain("stopped at the tokens cap after 32 turns")
  })

  test("includes failed members but still completes when one succeeds", async () => {
    const runner = fakeRunner({
      a: outcome("a", "ok", 1),
      b: new Error("kaboom")
    })
    const team = new TeamRunner(runner)
    const result = await team.run(registryOf("a", "b"), "squad", ["a", "b"], "do", undefined, SOURCE, undefined)
    expect(result.text).toContain("(1/2 members completed)")
    expect(result.text).toContain("## b — failed")
    expect(result.text).toContain("kaboom")
  })

  test("throws when all members fail", async () => {
    const runner = fakeRunner({ a: new Error("nope") })
    const team = new TeamRunner(runner)
    await expect(team.run(registryOf("a"), "squad", ["a"], "do", undefined, SOURCE, undefined)).rejects.toThrow("subagents: team \"squad\" produced no results")
  })

  test("throws when no member resolves to a definition", async () => {
    const runner = fakeRunner({})
    const team = new TeamRunner(runner)
    await expect(team.run(registryOf(), "squad", ["ghost"], "do", undefined, SOURCE, undefined)).rejects.toThrow("has no members with valid agent definitions")
  })

  test("throws for an invalid team shape", async () => {
    const runner = fakeRunner({})
    const team = new TeamRunner(runner)
    await expect(team.run(registryOf("a"), "squad", "not a team", "do", undefined, SOURCE, undefined)).rejects.toThrow("subagents: team \"squad\" is invalid")
  })

  test("prefixes the brief to the member task", async () => {
    let seenTask = ""
    const runner = {
      depth: 0,
      async withSlot<T>(fn: () => Promise<T>): Promise<T> {
        return fn()
      },
      async runAgent(def: AgentDefinition, task: string): Promise<TaskOutcome> {
        seenTask = task

        return outcome(def.name, "ok", 1)
      }
    } as unknown as Runner
    const team = new TeamRunner(runner)
    await team.run(registryOf("a"), "squad", { members: ["a"], brief: "Focus on safety." }, "ship it", undefined, SOURCE, undefined)
    expect(seenTask).toBe("Focus on safety.\n\nship it")
  })

  test("emits progress updates", async () => {
    const runner = fakeRunner({ a: outcome("a", "ok", 1) })
    const team = new TeamRunner(runner)
    const updates: string[] = []
    await team.run(registryOf("a"), "squad", ["a"], "do", undefined, SOURCE, undefined, (text) => updates.push(text))
    expect(updates.some((line) => line.startsWith("team squad —"))).toBe(true)
  })
})
