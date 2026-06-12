import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { loadRegistry } from "../subagents/registry.ts"
import type { AgentDefinition, AgentRegistry } from "../subagents/registry.ts"
import type { ModelSource, Runner, TaskOutcome } from "../subagents/runner.ts"
import { executeScript, parseScript } from "./sandbox.ts"
import type { ScriptGlobals, WorkflowBudget } from "./sandbox.ts"
import { validate } from "./validate.ts"

const RESULT_CAP = 30720
const LOG_LIMIT = 1000
const LOG_LINE_CHARS = 500
const ITEM_CAP = 1024
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const DELIVERY_RETRY_MS = 1000
const DELIVERY_MAX_ATTEMPTS = 30

interface PendingDelivery {
  key: string
  content: string
  details: Record<string, unknown>
  attempts: number
}

const WORKER: AgentDefinition = {
  name: "worker",
  description: "Generic workflow worker",
  model: "inherit",
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "astsearch", "astrewrite"],
  thinking: "",
  prompt: "You are a capable autonomous engineer executing one self-contained step of an orchestrated workflow. You cannot ask questions; make reasonable decisions, verify your own work, and finish. Your final message is consumed verbatim by a script, so output exactly the data that was requested — raw text or raw JSON with no preamble, no commentary, and no closing remarks.",
  source: "builtin"
}

export interface WorkflowsConfig {
  timeoutSec: number
  maxAgents: number
}

export interface WorkflowParams {
  script?: string
  name?: string
  args?: string
  budget?: number
  background?: boolean
}

export interface RunPhase {
  title: string
  agents: number
}

export type RunState = "running" | "done" | "failed" | "aborted"

export interface RunRecord {
  id: string
  name: string
  state: RunState
  phases: RunPhase[]
  logs: string[]
  agentCount: number
  tokens: number
  startedAt: number
  endedAt?: number
  result?: string
  background?: boolean
}

interface ToolText {
  type: "text"
  text: string
}

export interface ToolOutput {
  content: ToolText[]
  details: Record<string, unknown> | undefined
}

export type ToolUpdate = ((partial: ToolOutput) => void) | undefined

interface HistoryRun {
  id: string
  name: string
  agentCount: number
  state: string
  startedAt: number
  endedAt: number
}

interface SavedScript {
  name: string
  path: string
  description: string
  error: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function renderLog(message: unknown): string {
  if (typeof message === "string") return message
  try {
    return JSON.stringify(message) ?? String(message)
  } catch {
    return String(message)
  }
}

function renderValue(value: unknown): string {
  if (value === undefined) return "(the workflow script returned no value)"
  let rendered: string
  try {
    rendered = JSON.stringify(value, null, 2) ?? String(value)
  } catch (error) {
    return `(the workflow result could not be serialized: ${describeError(error)})`
  }
  if (rendered.length > RESULT_CAP) {
    return `${rendered.slice(0, RESULT_CAP)}\n\n[workflow result truncated: ${rendered.length} chars total]`
  }
  return rendered
}

function trimStack(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const stack = typeof error.stack === "string" ? error.stack : ""
  const frames = stack
    .split("\n")
    .slice(1)
    .filter((line) => line.includes("workflow.js"))
    .slice(0, 5)
    .map((frame) => frame.trim())
  return frames.length > 0 ? [error.message, ...frames].join("\n") : error.message
}

function parseArgs(raw: string | undefined): unknown {
  const text = (raw ?? "").trim()
  if (text === "") return undefined
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`workflow: the args parameter must be valid JSON: ${describeError(error)}`)
  }
}

function schemaInstruction(schema: Record<string, unknown>): string {
  let rendered: string
  try {
    rendered = JSON.stringify(schema) ?? ""
  } catch {
    throw new TypeError("workflow: agent() schema must be JSON-serializable")
  }
  return `Structured output requirement: end your final reply with exactly one fenced \`\`\`json code block containing a single JSON value that validates against this JSON schema:\n${rendered}\nDo not put any text after the closing fence.`
}

function checkStructured(structured: unknown, schema: Record<string, unknown>): string[] {
  if (structured === undefined) return ["$: the reply did not end with a fenced ```json block"]
  return validate(structured, schema)
}

function progressText(record: RunRecord): string {
  const lines = [`workflow ${record.name} ${record.id}: ${record.state} · ${record.agentCount} agents · ${record.tokens} tokens · ${formatDuration(record.startedAt, record.endedAt)}`]
  const phases = record.phases.map((phase) => `${phase.title}(${phase.agents})`).join(" · ")
  if (phases !== "") lines.push(`phases: ${phases}`)
  lines.push(...record.logs.slice(-4))
  return lines.join("\n")
}

function formatDuration(startedAt: number, endedAt: number | undefined): string {
  const total = Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m${total % 60}s`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

function stateMark(state: string): string {
  if (state === "running") return "▶"
  if (state === "done") return "✓"
  if (state === "aborted") return "■"
  return "✗"
}

function scriptDirs(cwd: string, trusted: boolean): string[] {
  const dirs = [join(homedir(), ".pi", "agent", "workflows")]
  if (trusted) dirs.push(join(cwd, ".pi", "workflows"))
  return dirs
}

function listScripts(cwd: string, trusted: boolean): SavedScript[] {
  const byName = new Map<string, SavedScript>()
  for (const dir of scriptDirs(cwd, trusted)) {
    let files: string[] = []
    try {
      files = readdirSync(dir)
        .filter((file) => file.endsWith(".js") || file.endsWith(".ts"))
        .sort()
    } catch {
      continue
    }
    for (const file of files) {
      const name = file.replace(/\.(js|ts)$/, "")
      const path = join(dir, file)
      try {
        const parsed = parseScript(readFileSync(path, "utf8"))
        byName.set(name, { name, path, description: parsed.meta.description, error: "" })
      } catch (error) {
        byName.set(name, { name, path, description: "", error: describeError(error) })
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function safeTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted()
  } catch {
    return false
  }
}

function historyRuns(ctx: ExtensionCommandContext): HistoryRun[] {
  let entries: unknown[] = []
  try {
    entries = ctx.sessionManager.getEntries()
  } catch {
    return []
  }
  const found: HistoryRun[] = []
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "workflows:run" || !isRecord(entry.data)) continue
    const data = entry.data
    if (typeof data.id !== "string" || typeof data.name !== "string") continue
    found.push({
      id: data.id,
      name: data.name,
      agentCount: typeof data.agentCount === "number" ? data.agentCount : 0,
      state: typeof data.state === "string" ? data.state : "unknown",
      startedAt: typeof data.startedAt === "number" ? data.startedAt : 0,
      endedAt: typeof data.endedAt === "number" ? data.endedAt : 0
    })
  }
  return found
}

export class Workflows {
  private readonly pi: ExtensionAPI
  private readonly config: WorkflowsConfig
  private readonly runner: () => Runner
  private readonly runs = new Map<string, RunRecord>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly killed = new Set<string>()
  private readonly outbox: PendingDelivery[] = []
  private deliveryTimer: ReturnType<typeof setInterval> | undefined
  private deliveryCtx: ExtensionContext | undefined

  constructor(pi: ExtensionAPI, config: WorkflowsConfig, runner: () => Runner) {
    this.pi = pi
    this.config = config
    this.runner = runner
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  killRun(id: string): "aborted" | "finished" | "missing" {
    const record = this.runs.get(id)
    if (!record) return "missing"
    if (record.state !== "running") return "finished"
    this.killed.add(id)
    const controller = this.controllers.get(id)
    if (controller) {
      try {
        controller.abort()
      } catch {}
    }
    return "aborted"
  }

  killAll(): void {
    for (const record of this.runs.values()) {
      if (record.state === "running") this.killRun(record.id)
    }
  }

  description(): string {
    return [
      "Run a deterministic multi-agent workflow: a plain-JavaScript script that orchestrates many subagents; loop state stays in script variables and only the script's return value comes back. Use only when the user explicitly asked for a workflow or large-scale orchestration; for one-off delegation use the task tool. Stopped or failed runs restart from scratch.",
      "Provide exactly one of script (inline source) or name (a saved script from .pi/workflows/ or ~/.pi/agent/workflows/). Optional: args (JSON value exposed as the args global), budget (advisory token target the script can read via the budget global; never enforced), background (return immediately; the result arrives as a follow-up message).",
      "The first statement must be export const meta = { name, description, phases } as a pure literal; phases: [{title}] pre-seeds the progress display. The body runs sandboxed with top-level await and return; Date.now(), Math.random(), and argless new Date() throw.",
      "Globals: agent(prompt, opts?) runs one subagent to completion and resolves to its final text, or with opts.schema (a JSON schema) to the validated parsed object (one retry); opts {agent, label, phase, schema, model}; failures resolve to null — chain .filter(Boolean). The default worker only has file/exec/ast tools; pass opts.agent (a registered subagent name) for anything else, e.g. librarian for web research. parallel(thunks) is a barrier over an array of () => agent(...) thunks. pipeline(items, ...stages) flows each item through stages (prev, item, index) with no barrier — prefer it over chained parallel. phase(title) groups progress, log(message) records a line, args is the parsed args value, budget is {total, spent(), remaining()}.",
      `Caps: ${this.config.maxAgents} agents per run, ${this.config.timeoutSec}s wall clock, ${ITEM_CAP} items per parallel/pipeline call; agent concurrency shares the subagents maxConcurrent slots. /workflows lists saved scripts and runs.`
    ].join("\n")
  }

  async execute(params: WorkflowParams, signal: AbortSignal | undefined, onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolOutput> {
    this.deliveryCtx = ctx
    const runner = this.runner()
    runner.ensureDepth()
    const inline = (params.script ?? "").trim()
    const named = (params.name ?? "").trim()
    if ((inline === "") === (named === "")) {
      throw new Error("workflow: provide exactly one of script (inline source) or name (a saved workflow)")
    }
    const scriptText = named !== "" ? this.loadNamed(named, ctx) : inline
    const parsed = parseScript(scriptText)
    const scriptArgs = parseArgs(params.args)
    const total = typeof params.budget === "number" && Number.isFinite(params.budget) && params.budget > 0 ? Math.floor(params.budget) : null
    const record: RunRecord = {
      id: `wf_${randomUUID().slice(0, 12)}`,
      name: parsed.meta.name,
      state: "running",
      phases: parsed.meta.phases.map((entry) => ({ title: entry.title, agents: 0 })),
      logs: [],
      agentCount: 0,
      tokens: 0,
      startedAt: Date.now()
    }
    this.runs.set(record.id, record)
    const controller = new AbortController()
    this.controllers.set(record.id, controller)
    if (params.background === true) {
      record.background = true
      const idle = (): void => {}
      const globals = this.buildGlobals(record, controller, ctx, scriptArgs, total, idle, runner)
      void this.runScript(record, controller, parsed.body, globals, undefined, idle)
        .then((output) => {
          this.deliver(`[workflows] background run ${record.id} (${record.name}) completed:\n\n${output.content[0]?.text ?? ""}`, { name: record.name, status: "completed", ...(output.details ?? {}) })
        })
        .catch(() => {
          this.deliver(`[workflows] background run ${record.id} (${record.name}) ${record.state}: ${record.result ?? ""}`, { runId: record.id, name: record.name, status: record.state })
        })
      return {
        content: [{ type: "text", text: `Background workflow run ${record.id} (${record.name}) started. The result will arrive as a follow-up message; /workflows view watches it live and /workflows kill ${record.id} aborts it.` }],
        details: { runId: record.id, name: record.name, background: true }
      }
    }
    const onParentAbort = (): void => controller.abort()
    signal?.addEventListener("abort", onParentAbort, { once: true })
    if (signal?.aborted) controller.abort()
    let lastEmit = 0
    const update = (force: boolean): void => {
      if (typeof onUpdate !== "function") return
      const now = Date.now()
      if (!force && now - lastEmit < 250) return
      lastEmit = now
      onUpdate({ content: [{ type: "text", text: progressText(record) }], details: undefined })
    }
    const globals = this.buildGlobals(record, controller, ctx, scriptArgs, total, update, runner)
    update(true)
    const ticker = setInterval(() => update(true), 1000)
    if (typeof ticker.unref === "function") ticker.unref()
    try {
      return await this.runScript(record, controller, parsed.body, globals, signal, update)
    } finally {
      clearInterval(ticker)
      signal?.removeEventListener("abort", onParentAbort)
    }
  }

  private async runScript(record: RunRecord, controller: AbortController, body: string, globals: ScriptGlobals, signal: AbortSignal | undefined, update: (force: boolean) => void): Promise<ToolOutput> {
    try {
      const value = await executeScript({
        body,
        globals,
        controller,
        timeoutMs: Math.max(1, this.config.timeoutSec) * 1000
      })
      record.state = "done"
      record.endedAt = Date.now()
      const rendered = renderValue(value)
      record.result = collapse(rendered).slice(0, 400)
      this.persist(record)
      update(true)
      return {
        content: [{ type: "text", text: rendered }],
        details: {
          runId: record.id,
          agents: record.agentCount,
          phases: record.phases.map((phase) => ({ ...phase })),
          tokens: record.tokens
        }
      }
    } catch (error) {
      record.state = signal?.aborted || this.killed.has(record.id) ? "aborted" : "failed"
      record.endedAt = Date.now()
      const reason = trimStack(error)
      record.result = collapse(reason).slice(0, 400)
      this.persist(record)
      throw new Error(`workflow ${record.id} (${record.name}) ${record.state}: ${reason}`)
    } finally {
      controller.abort()
      this.controllers.delete(record.id)
      this.killed.delete(record.id)
    }
  }

  stopDeliveries(): void {
    if (this.deliveryTimer !== undefined) {
      clearInterval(this.deliveryTimer)
      this.deliveryTimer = undefined
    }
    this.outbox.length = 0
  }

  private deliver(content: string, details: Record<string, unknown>): void {
    const key = randomUUID().slice(0, 8)
    this.outbox.push({ key, content, details: { ...details, deliveryKey: key }, attempts: 0 })
    this.flushDeliveries()
  }

  private confirmedKeys(ctx: ExtensionContext): Set<string> {
    const keys = new Set<string>()
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom_message" || entry.customType !== "workflows:result") continue
        const details: unknown = entry.details
        if (isRecord(details) && typeof details.deliveryKey === "string") keys.add(details.deliveryKey)
      }
    } catch {}
    return keys
  }

  private flushDeliveries(): void {
    const ctx = this.deliveryCtx
    if (ctx) {
      const confirmed = this.confirmedKeys(ctx)
      for (let index = this.outbox.length - 1; index >= 0; index--) {
        const item = this.outbox[index]
        if (confirmed.has(item.key)) {
          this.outbox.splice(index, 1)
        } else if (item.attempts >= DELIVERY_MAX_ATTEMPTS) {
          this.outbox.splice(index, 1)
          try {
            if (ctx.hasUI) ctx.ui.notify(`workflow: a background run result could not be delivered after ${DELIVERY_MAX_ATTEMPTS} attempts`, "error")
          } catch {}
        }
      }
    }
    if (this.outbox.length === 0) {
      if (this.deliveryTimer !== undefined) {
        clearInterval(this.deliveryTimer)
        this.deliveryTimer = undefined
      }
      return
    }
    if (this.deliveryTimer === undefined) {
      this.deliveryTimer = setInterval(() => this.flushDeliveries(), DELIVERY_RETRY_MS)
      if (typeof this.deliveryTimer.unref === "function") this.deliveryTimer.unref()
    }
    if (ctx) {
      let idle = false
      try {
        idle = ctx.isIdle()
      } catch {}
      if (!idle) return
    }
    const pending = [...this.outbox]
    if (!ctx) this.outbox.length = 0
    for (const item of pending) {
      item.attempts += 1
      try {
        this.pi.sendMessage(
          { customType: "workflows:result", content: item.content, display: true, details: item.details },
          { deliverAs: "followUp", triggerTurn: true }
        )
      } catch {}
    }
  }

  async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    this.deliveryCtx = ctx
    if (!ctx.hasUI) return
    const trimmed = args.trim()
    const [verb, ...rest] = trimmed.split(/\s+/)
    if (verb === "kill") {
      const id = rest.join(" ").trim()
      const result = id === "" ? "missing" : this.killRun(id)
      if (result === "aborted") ctx.ui.notify(`workflow: run ${id} aborted`, "info")
      else if (result === "finished") ctx.ui.notify(`workflow: run ${id} already finished`, "warning")
      else ctx.ui.notify(`workflow: no running run ${id || "(missing id)"}; run /workflows to list ids`, "error")
      return
    }
    if (verb === "show") {
      const id = rest.join(" ").trim()
      const record = id === "" ? undefined : this.runs.get(id)
      if (!record) {
        const known = [...this.runs.keys()]
        ctx.ui.notify(`workflow: no run ${id === "" ? "(missing id)" : `"${id}"`} in this session${known.length > 0 ? ` (known: ${known.join(", ")})` : ""}`, "error")
        return
      }
      const header = `${record.id} (${record.name}) — ${record.state} · ${record.agentCount} agents · ${record.tokens} tokens · ${formatDuration(record.startedAt, record.endedAt)}`
      const body = record.logs.length > 0 ? record.logs.join("\n") : "(no log lines were recorded)"
      ctx.ui.notify(`${header}\n\n${body}`, "info")
      return
    }
    ctx.ui.notify(this.report(ctx), "info")
  }

  private report(ctx: ExtensionCommandContext): string {
    const trusted = safeTrusted(ctx)
    const scripts = listScripts(ctx.cwd, trusted)
    const lines: string[] = [`Saved workflows (${scripts.length}):`]
    if (scripts.length === 0) {
      lines.push(`  none (searched ${scriptDirs(ctx.cwd, trusted).join(", ")})`)
    }
    for (const script of scripts) {
      if (script.error !== "") lines.push(`  ${script.name} — INVALID: ${script.error} (${script.path})`)
      else lines.push(`  ${script.name} — ${collapse(script.description).slice(0, 120)}`)
    }
    const live = [...this.runs.values()]
    const liveIds = new Set(live.map((record) => record.id))
    const history = historyRuns(ctx).filter((entry) => !liveIds.has(entry.id))
    lines.push("")
    lines.push(`Workflow runs this session (${live.length + history.length}):`)
    if (live.length + history.length === 0) lines.push("  none")
    for (const record of [...live].sort((a, b) => b.startedAt - a.startedAt)) {
      lines.push(`  ${stateMark(record.state)} ${record.id} ${record.name} · ${record.state} · ${record.agentCount} agents · ${record.tokens} tokens · ${formatDuration(record.startedAt, record.endedAt)}${record.background === true ? " · background" : ""}`)
      const phases = record.phases.map((phase) => `${phase.title}(${phase.agents})`).join(" ")
      if (phases !== "") lines.push(`      phases: ${phases}`)
      if (record.result !== undefined && record.result !== "") lines.push(`      ${record.result.slice(0, 120)}`)
    }
    for (const entry of history.sort((a, b) => b.startedAt - a.startedAt)) {
      lines.push(`  ${stateMark(entry.state)} ${entry.id} ${entry.name} · ${entry.state} · ${entry.agentCount} agents · ${formatDuration(entry.startedAt, entry.endedAt)} (earlier in this session file)`)
    }
    lines.push("")
    lines.push("Run a saved workflow via the workflow tool with {\"name\": \"<script>\"}; /workflows view opens the live run viewer, /workflows show <runId> prints a run's log lines, /workflows kill <runId> aborts a running workflow.")
    return lines.join("\n")
  }

  private loadNamed(name: string, ctx: ExtensionContext): string {
    if (!NAME_PATTERN.test(name)) throw new Error(`workflow: invalid workflow name "${name}"`)
    const trusted = safeTrusted(ctx)
    const ordered = [...scriptDirs(ctx.cwd, trusted)].reverse()
    const searched: string[] = []
    for (const dir of ordered) {
      for (const ext of [".js", ".ts"]) {
        const file = join(dir, `${name}${ext}`)
        searched.push(file)
        try {
          return readFileSync(file, "utf8")
        } catch {
          continue
        }
      }
    }
    const available = listScripts(ctx.cwd, trusted).map((script) => script.name)
    const hint = available.length > 0 ? `; available: ${available.join(", ")}` : ` (searched ${searched.join(", ")})`
    throw new Error(`workflow: no saved workflow named "${name}"${hint}`)
  }

  private buildGlobals(record: RunRecord, controller: AbortController, ctx: ExtensionContext, scriptArgs: unknown, total: number | null, update: (force: boolean) => void, runner: Runner): ScriptGlobals {
    const registry: AgentRegistry = loadRegistry(ctx.cwd)
    const source: ModelSource & { cwd: string } = { cwd: ctx.cwd, model: ctx.model, modelRegistry: ctx.modelRegistry }
    let current = -1
    const log = (message: unknown): void => {
      const text = renderLog(message)
      record.logs.push(text.length > LOG_LINE_CHARS ? `${text.slice(0, LOG_LINE_CHARS - 1)}…` : text)
      if (record.logs.length > LOG_LIMIT) record.logs.splice(0, record.logs.length - LOG_LIMIT)
      update(false)
    }
    const findPhase = (title: string): number => {
      const exact = record.phases.findIndex((phase) => phase.title === title)
      if (exact !== -1) return exact
      const folded = record.phases.findIndex((phase) => phase.title.toLowerCase() === title.toLowerCase())
      if (folded !== -1) return folded
      record.phases.push({ title, agents: 0 })
      return record.phases.length - 1
    }
    const phase = (title: unknown): void => {
      if (typeof title !== "string" || title.trim() === "") {
        throw new TypeError("workflow: phase() requires a non-empty title string")
      }
      current = findPhase(title.trim())
      log(`phase: ${record.phases[current].title}`)
    }
    const budget: WorkflowBudget = Object.freeze({
      total,
      spent: (): number => record.tokens,
      remaining: (): number => (total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - record.tokens))
    })
    const agentRun = async (prompt: unknown, opts?: unknown): Promise<unknown> => {
      if (controller.signal.aborted) throw new Error("workflow: run aborted")
      const task = typeof prompt === "string" ? prompt.trim() : ""
      if (task === "") throw new TypeError("workflow: agent() requires a non-empty prompt string")
      const options = isRecord(opts) ? opts : {}
      if (record.agentCount >= this.config.maxAgents) {
        const cap = new Error(`workflow: the agent cap of ${this.config.maxAgents} (workflows.maxAgents) was reached; the run was aborted`)
        controller.abort(cap)
        throw cap
      }
      let definition = WORKER
      if (typeof options.agent === "string" && options.agent.trim() !== "") {
        const requested = options.agent.trim()
        const found = registry.agents.get(requested)
        if (!found) {
          const names = [...registry.agents.keys()]
          throw new Error(`workflow: unknown agent "${requested}"${names.length > 0 ? ` (available: ${names.join(", ")})` : ""}`)
        }
        definition = found
      }
      if (typeof options.model === "string" && options.model.trim() !== "") {
        definition = { ...definition, model: options.model.trim() }
      }
      const schema = options.schema
      if (schema !== undefined && !isRecord(schema)) {
        throw new TypeError("workflow: agent() schema must be a JSON schema object")
      }
      record.agentCount += 1
      const index = record.agentCount
      const target = typeof options.phase === "string" && options.phase.trim() !== "" ? findPhase(options.phase.trim()) : current
      if (target !== -1) record.phases[target].agents += 1
      const label = typeof options.label === "string" && options.label.trim() !== "" ? options.label.trim() : collapse(task).slice(0, 60)
      update(false)
      const fullTask = schema === undefined ? task : `${task}\n\n${schemaInstruction(schema)}`
      const launch = async (text: string): Promise<TaskOutcome> => {
        let seen = 0
        const track = (tokens: number): void => {
          record.tokens += Math.max(0, tokens - seen)
          seen = tokens
          update(false)
        }
        const outcome = await runner.withSlot(() => runner.runAgent(definition, text, undefined, source, controller.signal, undefined, `workflow:${record.id}`, track))
        track(outcome.tokens)
        return outcome
      }
      try {
        let outcome = await launch(fullTask)
        if (schema === undefined) {
          log(`agent[${index}] ${label}: done (${outcome.turns} turns, ${outcome.tokens} tokens)`)
          return outcome.text
        }
        let errors = checkStructured(outcome.structured, schema)
        if (errors.length > 0) {
          const retryTask = `${fullTask}\n\nYour previous reply failed schema validation:\n${errors.map((item) => `- ${item}`).join("\n")}\n\nReply again and make the fenced json block satisfy the schema exactly.`
          outcome = await launch(retryTask)
          errors = checkStructured(outcome.structured, schema)
        }
        if (errors.length > 0) {
          log(`agent[${index}] ${label}: failed — structured output did not match the schema after one retry (${errors[0]})`)
          return null
        }
        log(`agent[${index}] ${label}: done (${outcome.tokens} tokens, structured)`)
        return outcome.structured
      } catch (error) {
        if (controller.signal.aborted) throw new Error("workflow: run aborted")
        log(`agent[${index}] ${label}: failed — ${describeError(error)}`)
        return null
      }
    }
    const agent = (prompt: unknown, opts?: unknown): Promise<unknown> => {
      const run = agentRun(prompt, opts)
      void run.catch(() => undefined)
      return run
    }
    const parallel = (thunks: unknown): Promise<unknown[]> => {
      if (!Array.isArray(thunks)) {
        throw new TypeError("workflow: parallel() expects an array of functions, not promises; wrap each call: () => agent(...)")
      }
      if (thunks.length > ITEM_CAP) throw new Error(`workflow: parallel() supports at most ${ITEM_CAP} thunks per call`)
      for (const thunk of thunks) {
        if (typeof thunk !== "function") {
          throw new TypeError("workflow: parallel() expects an array of functions, not promises; wrap each call: () => agent(...)")
        }
      }
      return Promise.all(
        thunks.map((thunk, index) =>
          Promise.resolve()
            .then(() => (thunk as () => unknown)())
            .catch((error: unknown) => {
              if (!controller.signal.aborted) log(`parallel[${index}] failed: ${describeError(error)}`)
              return null
            })
        )
      )
    }
    const pipeline = (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
      if (!Array.isArray(items)) throw new TypeError("workflow: pipeline() expects an array of items as its first argument")
      if (items.length > ITEM_CAP) throw new Error(`workflow: pipeline() supports at most ${ITEM_CAP} items per call`)
      for (const stage of stages) {
        if (typeof stage !== "function") throw new TypeError("workflow: pipeline() stages must be functions of (prev, item, index)")
      }
      return Promise.all(
        items.map(async (item: unknown, index: number): Promise<unknown> => {
          let value: unknown
          try {
            value = await item
          } catch (error) {
            if (!controller.signal.aborted) log(`pipeline[${index}] failed: ${describeError(error)}`)
            return null
          }
          const original = value
          for (const stage of stages) {
            if (value === null) return null
            try {
              value = await (stage as (prev: unknown, source: unknown, position: number) => unknown)(value, original, index)
            } catch (error) {
              if (!controller.signal.aborted) log(`pipeline[${index}] failed: ${describeError(error)}`)
              return null
            }
          }
          return value
        })
      )
    }
    return { agent, parallel, pipeline, phase, log, args: scriptArgs, budget }
  }

  private persist(record: RunRecord): void {
    try {
      this.pi.appendEntry("workflows:run", {
        id: record.id,
        name: record.name,
        agentCount: record.agentCount,
        state: record.state,
        startedAt: record.startedAt,
        endedAt: record.endedAt ?? Date.now()
      })
    } catch {}
  }
}
