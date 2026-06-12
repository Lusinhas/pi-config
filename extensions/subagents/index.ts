import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Type } from "typebox"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { runAdvisor } from "./advisor.ts"
import { loadRegistry } from "./registry.ts"
import type { AgentDefinition, AgentRegistry } from "./registry.ts"
import { Runner, readDepth } from "./runner.ts"
import type { SubagentsConfig, TaskOutcome } from "./runner.ts"
import { runTeam } from "./teams.ts"
import { openViewer, taskReport, widgetLines } from "./viewer.ts"

const defaultConfig: SubagentsConfig = {
  maxConcurrent: 4,
  maxDepth: 2,
  maxTurns: 32,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key]
    if (isRecord(current) && isRecord(value)) {
      merged[key] = deepMerge(current, value)
    } else if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged
}

function toCount(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  return rounded < minimum ? minimum : rounded
}

function normalizeConfig(raw: Record<string, unknown>): SubagentsConfig {
  return {
    maxConcurrent: toCount(raw.maxConcurrent, defaultConfig.maxConcurrent, 1),
    maxDepth: toCount(raw.maxDepth, defaultConfig.maxDepth, 0),
    maxTurns: toCount(raw.maxTurns, defaultConfig.maxTurns, 0),
    maxTokens: toCount(raw.maxTokens, defaultConfig.maxTokens, 0),
    advisorModel: typeof raw.advisorModel === "string" ? raw.advisorModel : defaultConfig.advisorModel,
    advisorThinking: typeof raw.advisorThinking === "string" ? raw.advisorThinking : defaultConfig.advisorThinking,
    advisorContextChars: toCount(raw.advisorContextChars, defaultConfig.advisorContextChars, 1000),
    widget: raw.widget !== false,
    widgetLimit: toCount(raw.widgetLimit, defaultConfig.widgetLimit, 1),
    transcriptLimit: toCount(raw.transcriptLimit, defaultConfig.transcriptLimit, 10),
    activityChars: toCount(raw.activityChars, defaultConfig.activityChars, 20),
    keepFinished: toCount(raw.keepFinished, defaultConfig.keepFinished, 0),
    teams: isRecord(raw.teams) ? raw.teams : { ...defaultConfig.teams }
  }
}

export function loadConfig(): SubagentsConfig {
  let merged: Record<string, unknown> = { ...defaultConfig }
  try {
    const shipped: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))
    if (isRecord(shipped)) merged = deepMerge(merged, shipped)
  } catch {
    merged = { ...merged }
  }
  const overrides = [join(homedir(), ".pi", "agent", "piconfig.json"), join(process.cwd(), ".pi", "piconfig.json")]
  for (const file of overrides) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (isRecord(parsed) && isRecord(parsed.subagents)) merged = deepMerge(merged, parsed.subagents)
    } catch {
      continue
    }
  }
  return normalizeConfig(merged)
}

interface ToolText {
  type: "text"
  text: string
}

interface ToolOutput {
  content: ToolText[]
  details: Record<string, unknown> | undefined
}

type ToolUpdate = ((partial: ToolOutput) => void) | undefined

interface TaskParams {
  agent: string
  task: string
  context?: string
  background?: boolean
}

interface AdvisorParams {
  question: string
}

function taskDescription(registry: AgentRegistry, teams: Record<string, unknown>): string {
  const lines = [
    "Delegate a self-contained task to a named subagent with its own isolated context, prompt, model, and tool scope; it cannot see this conversation. agent \"team:<name>\" fans the task out to a configured team concurrently. background=true returns immediately and delivers the result as a follow-up message."
  ]
  if (registry.agents.size > 0) {
    lines.push("Available agents:")
    for (const definition of registry.agents.values()) {
      lines.push(`- ${definition.name}: ${definition.description}`)
    }
  }
  const teamNames = Object.keys(teams)
  if (teamNames.length > 0) {
    lines.push(`Available teams: ${teamNames.map((team) => `team:${team}`).join(", ")}`)
  }
  return lines.join("\n")
}

function outcomeText(outcome: TaskOutcome): string {
  const text = outcome.text !== "" ? outcome.text : "(the subagent produced no final text)"
  const notes: string[] = []
  if (outcome.capped === "turns") notes.push(`stopped at the turn cap after ${outcome.turns} turns; the result may be incomplete`)
  if (outcome.capped === "tokens") notes.push(`stopped at the token cap after ${outcome.tokens} tokens; the result may be incomplete`)
  if (outcome.dropped.length > 0) notes.push(`unavailable tools were skipped: ${outcome.dropped.join(", ")}`)
  if (outcome.note) notes.push(outcome.note)
  return notes.length > 0 ? `${text}\n\n[${notes.join("; ")}]` : text
}

function outcomeDetails(outcome: TaskOutcome): Record<string, unknown> {
  const details: Record<string, unknown> = {
    agent: outcome.agent,
    model: outcome.model,
    turns: outcome.turns,
    tokens: outcome.tokens,
    capped: outcome.capped,
    droppedTools: outcome.dropped
  }
  if (outcome.structured !== undefined) details.structured = outcome.structured
  if (outcome.note) details.note = outcome.note
  return details
}

function formatElapsed(startedAt: number): string {
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m${total % 60}s`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

function describeAgent(definition: AgentDefinition): string {
  const scope = definition.tools === "all" ? "all" : definition.tools.join(" ")
  return [
    `name: ${definition.name}`,
    `description: ${definition.description}`,
    `model: ${definition.model}`,
    `thinking: ${definition.thinking === "" ? "(session default)" : definition.thinking}`,
    `tools: ${scope}`,
    `source: ${definition.source}`,
    `prompt: ${definition.prompt.length} chars`
  ].join("\n")
}

export default function subagents(pi: ExtensionAPI): void {
  const config = loadConfig()
  const runner = new Runner(pi, config, readDepth())
  const initialRegistry = loadRegistry(process.cwd())

  pi.events.on("piconfig:subagents:runner", (payload) => {
    if (isRecord(payload) && typeof payload.provide === "function") {
      (payload.provide as (instance: Runner) => void)(runner)
    }
  })
  let widgetCtx: ExtensionContext | undefined
  let widgetTimer: ReturnType<typeof setTimeout> | undefined
  let widgetTicker: ReturnType<typeof setInterval> | undefined

  const stopWidgetTicker = (): void => {
    if (widgetTicker !== undefined) {
      clearInterval(widgetTicker)
      widgetTicker = undefined
    }
  }

  const renderWidget = (): void => {
    const ctx = widgetCtx
    if (!ctx || !config.widget || !ctx.hasUI) {
      stopWidgetTicker()
      return
    }
    try {
      const lines = widgetLines(runner, config.widgetLimit, ctx.ui.theme)
      ctx.ui.setWidget("subagents", lines.length > 0 ? lines : undefined)
      if (lines.length > 0) {
        if (widgetTicker === undefined) {
          widgetTicker = setInterval(renderWidget, 1000)
          if (typeof widgetTicker.unref === "function") widgetTicker.unref()
        }
      } else {
        stopWidgetTicker()
      }
    } catch {
      stopWidgetTicker()
    }
  }

  runner.setOnTasksChanged(() => {
    if (widgetTimer !== undefined) return
    widgetTimer = setTimeout(() => {
      widgetTimer = undefined
      renderWidget()
    }, 200)
  })

  pi.on("session_start", (_event, ctx) => {
    widgetCtx = ctx
    runner.noteContext(ctx)
    renderWidget()
  })

  pi.on("session_shutdown", () => {
    if (widgetTimer !== undefined) {
      clearTimeout(widgetTimer)
      widgetTimer = undefined
    }
    stopWidgetTicker()
    try {
      runner.killAll()
      runner.abortJobs()
      runner.stopDeliveries()
    } catch {}
  })

  pi.registerTool({
    name: "task",
    label: "Task",
    description: taskDescription(initialRegistry, config.teams),
    parameters: Type.Object({
      agent: Type.String({ description: "Name of the subagent to run, or team:<name> for a configured team" }),
      task: Type.String({ description: "Complete, self-contained instructions for the subagent" }),
      context: Type.Optional(Type.String({ description: "Extra background the subagent needs (it cannot see this conversation)" })),
      background: Type.Optional(Type.Boolean({ description: "Run in the background and deliver the result as a follow-up message" }))
    }),
    execute: async (_toolCallId: string, params: TaskParams, signal: AbortSignal | undefined, onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolOutput> => {
      runner.ensureDepth()
      runner.noteContext(ctx)
      const agentSpec = (params.agent ?? "").trim()
      const taskText = (params.task ?? "").trim()
      if (agentSpec === "") throw new Error("subagents: the agent parameter is required")
      if (taskText === "") throw new Error("subagents: the task parameter is required")
      const source = { cwd: ctx.cwd, model: ctx.model, modelRegistry: ctx.modelRegistry }
      const startedAt = Date.now()
      let status = ""
      let statusTicker: ReturnType<typeof setInterval> | undefined
      const emitStatus = (): void => {
        if (typeof onUpdate !== "function" || status === "") return
        onUpdate({ content: [{ type: "text", text: `${status} · ${formatElapsed(startedAt)}` }], details: undefined })
      }
      const update = (text: string): void => {
        status = text
        if (statusTicker === undefined && typeof onUpdate === "function") {
          statusTicker = setInterval(emitStatus, 1000)
          if (typeof statusTicker.unref === "function") statusTicker.unref()
        }
        emitStatus()
      }
      try {
        const registry = loadRegistry(ctx.cwd)
        if (agentSpec.startsWith("team:")) {
          const teamName = agentSpec.slice("team:".length).trim()
          const raw = teamName === "" ? undefined : config.teams[teamName]
          if (raw === undefined) {
            const known = Object.keys(config.teams)
            const hint = known.length > 0 ? ` (configured teams: ${known.join(", ")})` : " (no teams are configured under the subagents.teams config key)"
            throw new Error(`subagents: unknown team "${teamName}"${hint}`)
          }
          if (params.background === true) {
            const jobId = runner.startJob(`team:${teamName}`, (jobSignal) => runTeam(runner, registry, teamName, raw, taskText, params.context, source, jobSignal))
            return {
              content: [{ type: "text", text: `Background job ${jobId} started for team "${teamName}". The merged report will arrive as a follow-up message.` }],
              details: { jobId, team: teamName, background: true }
            }
          }
          update(`team ${teamName}: starting`)
          const result = await runTeam(runner, registry, teamName, raw, taskText, params.context, source, signal, update)
          return { content: [{ type: "text", text: result.text }], details: result.details }
        }
        const definition = registry.agents.get(agentSpec)
        if (!definition) {
          const names = [...registry.agents.keys()]
          const available = names.length > 0 ? `Available agents: ${names.join(", ")}.` : `No agent definitions were found (searched: ${registry.paths.join(", ")}).`
          const broken = registry.errors.length > 0 ? ` ${registry.errors.length} definition file(s) failed to parse; run /agents for details.` : ""
          throw new Error(`subagents: unknown agent "${agentSpec}". ${available}${broken}`)
        }
        if (params.background === true) {
          const jobId = runner.startJob(definition.name, async (jobSignal) => {
            const outcome = await runner.runAgent(definition, taskText, params.context, source, jobSignal, undefined, "background")
            return { text: outcomeText(outcome), details: outcomeDetails(outcome) }
          })
          return {
            content: [{ type: "text", text: `Background job ${jobId} started for agent "${definition.name}". The result will arrive as a follow-up message.` }],
            details: { jobId, agent: definition.name, background: true }
          }
        }
        update(`${definition.name}: starting`)
        const outcome = await runner.runAgent(definition, taskText, params.context, source, signal, (turns) => {
          update(`${definition.name}: turn ${turns}${config.maxTurns > 0 ? ` of ${config.maxTurns}` : ""}`)
        })
        return { content: [{ type: "text", text: outcomeText(outcome) }], details: outcomeDetails(outcome) }
      } finally {
        if (statusTicker !== undefined) clearInterval(statusTicker)
      }
    }
  })

  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description: "Ask an independent advisor model for a second opinion on the current conversation. The advisor receives a transcript with oversized tool payloads stripped, plus your question, and returns candid advice.",
    parameters: Type.Object({
      question: Type.String({ description: "What you want a second opinion on" })
    }),
    execute: async (_toolCallId: string, params: AdvisorParams, signal: AbortSignal | undefined, onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolOutput> => {
      const update = (text: string): void => {
        if (typeof onUpdate === "function") onUpdate({ content: [{ type: "text", text }], details: undefined })
      }
      update("advisor: consulting")
      const result = await runAdvisor(
        params.question ?? "",
        config,
        runner,
        { cwd: ctx.cwd, model: ctx.model, modelRegistry: ctx.modelRegistry, sessionManager: ctx.sessionManager },
        signal,
        (turns) => update(`advisor: turn ${turns}`)
      )
      return { content: [{ type: "text", text: result.text }], details: result.details }
    }
  })

  pi.registerCommand("agents", {
    description: "List subagent definitions, or manage running tasks: /agents view (live viewer), /agents tasks, /agents kill <id>",
    getArgumentCompletions: (prefix: string): Array<{ value: string; label: string }> | null => {
      const needle = prefix.trim().toLowerCase()
      const items = [
        { value: "view", label: "view — open the live subagent task viewer" },
        { value: "tasks", label: "tasks — print the task list" },
        { value: "kill", label: "kill <id> — abort a running task" }
      ].filter((item) => item.value.startsWith(needle))
      return items.length > 0 ? items : null
    },
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const registry = loadRegistry(ctx.cwd)
      const requested = args.trim()
      const [verb, ...rest] = requested.split(/\s+/)
      if (verb === "view") {
        if (!ctx.hasUI) {
          return
        }
        widgetCtx = ctx
        await openViewer(ctx, runner)
        renderWidget()
        return
      }
      if (verb === "tasks") {
        if (ctx.hasUI) ctx.ui.notify(taskReport(runner), "info")
        return
      }
      if (verb === "kill") {
        const id = rest.join(" ").trim()
        const result = id === "" ? "missing" : runner.killTask(id)
        if (ctx.hasUI) {
          if (result === "aborted") ctx.ui.notify(`subagents: task ${id} aborted`, "info")
          else if (result === "finished") ctx.ui.notify(`subagents: task ${id} already finished`, "warning")
          else ctx.ui.notify(`subagents: no running task ${id || "(missing id)"}; run /agents tasks to list ids`, "error")
        }
        return
      }
      if (!ctx.hasUI) return
      if (requested !== "") {
        const definition = registry.agents.get(requested)
        if (definition) {
          ctx.ui.notify(describeAgent(definition), "info")
        } else {
          const names = [...registry.agents.keys()]
          ctx.ui.notify(`No agent named "${requested}". Known agents: ${names.length > 0 ? names.join(", ") : "none"}`, "error")
        }
        return
      }
      const options: string[] = []
      const detailByOption = new Map<string, { text: string; level: "info" | "error" }>()
      for (const definition of registry.agents.values()) {
        const scope = definition.tools === "all" ? "all tools" : definition.tools.join(" ")
        const option = `${definition.name} [${definition.model}] (${scope}) — ${definition.source}`
        options.push(option)
        detailByOption.set(option, { text: describeAgent(definition), level: "info" })
      }
      for (const error of registry.errors) {
        const option = `INVALID ${error.source}`
        options.push(option)
        detailByOption.set(option, { text: `${error.source}\n\n${error.reason}`, level: "error" })
      }
      if (options.length === 0) {
        ctx.ui.notify(`No agent definitions found. Searched:\n${registry.paths.join("\n")}`, "warning")
        return
      }
      const choice = await ctx.ui.select(`Agents — ${registry.agents.size} valid, ${registry.errors.length} invalid`, options)
      if (choice === undefined) return
      const detail = detailByOption.get(choice)
      if (detail) ctx.ui.notify(detail.text, detail.level)
    }
  })
}
