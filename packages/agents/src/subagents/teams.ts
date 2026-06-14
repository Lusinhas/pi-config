import type { AgentRegistry } from "./registry.ts"
import type { CapReason } from "./engine.ts"
import type { Runner } from "./index.ts"
import type { ModelSource, RouterRoles } from "./model.ts"

export interface TeamDefinition {
  members: string[]
  brief: string
}

export interface MemberReport {
  agent: string
  status: "completed" | "capped" | "failed"
  model: string
  turns: number
  tokens: number
  capped: CapReason
  detail: string
}

export interface TeamResult {
  text: string
  details: Record<string, unknown>
}

export type TeamSource = ModelSource & { cwd: string; roles?: RouterRoles }

export function parseTeam(raw: unknown): TeamDefinition | string {
  if (Array.isArray(raw)) {
    const members = [...new Set(raw.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()))]

    if (members.length === 0) {
      return "team has no members"
    }

    return { members, brief: "" }
  }

  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>
    const list = Array.isArray(record.members) ? record.members : []
    const members = [...new Set(list.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()))]

    if (members.length === 0) {
      return "team has no members (expected a non-empty \"members\" array of agent names)"
    }

    const brief = typeof record.brief === "string" ? record.brief.trim() : ""

    return { members, brief }
  }

  return "team definition must be an array of agent names or an object with a \"members\" array and optional \"brief\" string"
}

function heading(report: MemberReport): string {
  if (report.status === "completed") {
    return `completed in ${report.turns} turn${report.turns === 1 ? "" : "s"}`
  }

  if (report.status === "capped") {
    return `stopped at the ${report.capped} cap after ${report.turns} turns`
  }

  return "failed"
}

export function buildReport(name: string, reports: MemberReport[], completed: number): string {
  const sections = reports.map((report) => `## ${report.agent} — ${heading(report)}\n\n${report.detail}`)

  return `# Team ${name} report (${completed}/${reports.length} members completed)\n\n${sections.join("\n\n")}`
}

export class TeamRunner {
  private readonly runner: Runner

  constructor(runner: Runner) {
    this.runner = runner
  }

  async run(registry: AgentRegistry, name: string, raw: unknown, task: string, context: string | undefined, source: TeamSource, signal: AbortSignal | undefined, progress?: (text: string) => void): Promise<TeamResult> {
    const team = parseTeam(raw)

    if (typeof team === "string") {
      throw new Error(`subagents: team "${name}" is invalid: ${team}`)
    }

    const states = new Map<string, string>()

    const emit = (): void => {
      if (!progress) {
        return
      }

      const parts = [...states.entries()].map(([member, state]) => `${member}: ${state}`)

      try {
        progress(`team ${name} — ${parts.join(" | ")}`)
      } catch {
        return
      }
    }

    const memberTask = team.brief !== "" ? `${team.brief}\n\n${task}` : task
    const reports: MemberReport[] = []
    const pending: Array<Promise<void>> = []

    for (const member of team.members) {
      const definition = registry.agents.get(member)

      if (!definition) {
        states.set(member, "unknown agent")
        reports.push({
          agent: member,
          status: "failed",
          model: "",
          turns: 0,
          tokens: 0,
          capped: false,
          detail: `no agent definition named "${member}" was found`
        })
        continue
      }

      states.set(member, "queued")
      pending.push(
        this.runner
          .withSlot(async () => {
            states.set(member, "running")
            emit()
            const outcome = await this.runner.runAgent(definition, memberTask, context, source, signal, (turns) => {
              states.set(member, `turn ${turns}`)
              emit()
            }, `team:${name}`)
            states.set(member, outcome.capped === false ? "done" : `capped (${outcome.capped})`)
            emit()
            reports.push({
              agent: member,
              status: outcome.capped === false ? "completed" : "capped",
              model: outcome.model,
              turns: outcome.turns,
              tokens: outcome.tokens,
              capped: outcome.capped,
              detail: outcome.text !== "" ? outcome.text : "(no output)"
            })
          })
          .catch((error: unknown) => {
            states.set(member, "failed")
            emit()
            reports.push({
              agent: member,
              status: "failed",
              model: "",
              turns: 0,
              tokens: 0,
              capped: false,
              detail: error instanceof Error ? error.message : String(error)
            })
          })
      )
    }

    if (pending.length === 0) {
      throw new Error(`subagents: team "${name}" has no members with valid agent definitions (members: ${team.members.join(", ")})`)
    }

    emit()
    await Promise.allSettled(pending)
    const order = new Map(team.members.map((member, index) => [member, index]))
    reports.sort((a, b) => (order.get(a.agent) ?? 0) - (order.get(b.agent) ?? 0))
    const completed = reports.filter((report) => report.status !== "failed").length

    if (completed === 0) {
      const reasons = reports.map((report) => `${report.agent}: ${report.detail}`).join("\n")

      throw new Error(`subagents: team "${name}" produced no results:\n${reasons}`)
    }

    const text = buildReport(name, reports, completed)

    return {
      text,
      details: {
        team: name,
        members: reports.map((report) => ({
          agent: report.agent,
          status: report.status,
          model: report.model,
          turns: report.turns,
          tokens: report.tokens,
          capped: report.capped
        }))
      }
    }
  }
}
