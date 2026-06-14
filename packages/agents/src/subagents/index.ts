import { randomUUID } from "node:crypto"
import type { AgentDefinition } from "./registry.ts"
import type { SubagentsConfig } from "./config.ts"
import { LoopEngine, YIELD_INSTRUCTION } from "./engine.ts"
import type { CapReason } from "./engine.ts"
import { resolveModel, RouterRoles } from "./model.ts"
import type { ModelSource } from "./model.ts"

export { LoopEngine, YIELD_INSTRUCTION, extractMessageText, extractStructured, extractText, usageTokens } from "./engine.ts"
export type { CapReason, CompactResolver, CreatedSession, LoopOptions, LoopResult, SessionCreateOptions, SessionFactory, SessionLike } from "./engine.ts"
export { describeModel, findModel, readDepth, readLabel, resolveModel, RouterRoles, withDepthMarker } from "./model.ts"
export type { ModelSource, ResolvedModel } from "./model.ts"
export { Config, DEFAULT_CONFIG } from "./config.ts"
export type { SubagentsConfig } from "./config.ts"
export { loadRegistry, RegistryLoader, parseAgentFile, parseDocument, stripQuotes, THINKING_LEVELS, AgentDocumentParser, PackageAgentManifest, QuoteStripper } from "./registry.ts"
export type { AgentDefinition, AgentParseError, AgentRegistry, ThinkingLevel } from "./registry.ts"
export { Advisor, ADVISOR_PROMPT } from "./advisor.ts"
export type { AdvisorContext, AdvisorResult } from "./advisor.ts"
export { TeamRunner, parseTeam } from "./teams.ts"
export type { MemberReport, TeamDefinition, TeamResult, TeamSource } from "./teams.ts"
export { ViewerModel, formatElapsedSeconds, glyph, taskLine, taskReport, transcriptLines, widgetLines } from "./render.ts"
export type { Painter, Truncate, ViewerAction, ViewerKey } from "./render.ts"

export interface TranscriptEntry {
  at: number
  kind: "tool" | "text" | "info"
  text: string
}

export type TaskState = "running" | "done" | "failed" | "aborted"

export interface TaskRecord {
  id: string
  agent: string
  via: string
  state: TaskState
  turns: number
  tokens: number
  startedAt: number
  endedAt?: number
  activity: string
  transcript: TranscriptEntry[]
  result?: string
}

export interface TaskOutcome {
  agent: string
  model: string
  text: string
  turns: number
  tokens: number
  capped: CapReason
  structured?: unknown
  dropped: string[]
  note?: string
}

export interface ToolLister {
  getAllTools(): unknown
}

export interface MessageSink {
  sendMessage(message: Record<string, unknown>, options: Record<string, unknown>): void
}

export interface DeliveryContext {
  hasUI: boolean
  isIdle(): boolean
  ui: { notify(message: string, level: "info" | "warning" | "error"): void }
  sessionManager: { getEntries(): unknown[] }
}

export interface RunnerSource extends ModelSource {
  cwd: string
  roles?: RouterRoles
}

export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "astsearch", "astrewrite", "batch"]

const DELIVERY_RETRY_MS = 1000
const DELIVERY_MAX_ATTEMPTS = 30
const TRANSCRIPT_TEXT_CAP = 4000
const ACTIVITY_MIN_WIDTH = 20
const ACTIVITY_PREFIX_RESERVE = 48

interface PendingDelivery {
  key: string
  content: string
  details: Record<string, unknown>
  attempts: number
}

interface JobEntry {
  label: string
  controller: AbortController
}

interface TaskEntry {
  record: TaskRecord
  controller: AbortController
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class Runner {
  readonly depth: number
  private readonly engine: LoopEngine
  private readonly tools: ToolLister
  private readonly sink: MessageSink
  private readonly config: SubagentsConfig
  private active = 0
  private readonly waiters: Array<() => void> = []
  private readonly jobs = new Map<string, JobEntry>()
  private readonly tasks = new Map<string, TaskEntry>()
  private onTasksChanged?: () => void
  private readonly outbox: PendingDelivery[] = []
  private deliveryTimer: ReturnType<typeof setInterval> | undefined
  private deliveryCtx: DeliveryContext | undefined

  constructor(engine: LoopEngine, tools: ToolLister, sink: MessageSink, config: SubagentsConfig, depth: number) {
    this.engine = engine
    this.tools = tools
    this.sink = sink
    this.config = config
    this.depth = depth
  }

  setOnTasksChanged(listener: (() => void) | undefined): void {
    this.onTasksChanged = listener
  }

  listTasks(): TaskRecord[] {
    return [...this.tasks.values()].map((entry) => entry.record).sort((a, b) => b.startedAt - a.startedAt)
  }

  killTask(id: string): "aborted" | "finished" | "missing" {
    const entry = this.tasks.get(id)

    if (!entry) {
      return "missing"
    }

    if (entry.record.state !== "running") {
      return "finished"
    }

    this.abortController(entry.controller)

    return "aborted"
  }

  killAll(): void {
    for (const entry of this.tasks.values()) {
      if (entry.record.state !== "running") {
        continue
      }

      this.abortController(entry.controller)
    }
  }

  ensureDepth(): void {
    if (this.depth >= this.config.maxDepth) {
      throw new Error(`subagents: task depth limit of ${this.config.maxDepth} reached (current depth ${this.depth}); finish this task without delegating further`)
    }
  }

  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    const limit = Math.max(1, this.config.maxConcurrent)

    while (this.active >= limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }

    this.active += 1

    try {
      return await fn()
    } finally {
      this.active -= 1
      const next = this.waiters.shift()

      if (next) {
        next()
      }
    }
  }

  resolveToolScope(definition: AgentDefinition): { tools?: string[]; dropped: string[] } {
    if (definition.tools === "all") {
      return { dropped: [] }
    }

    const known: string[] = []

    try {
      const all = this.tools.getAllTools()

      if (Array.isArray(all)) {
        for (const item of all) {
          if (typeof item === "string") {
            known.push(item)
          } else if (isRecord(item) && typeof item.name === "string") {
            known.push(item.name)
          }
        }
      }
    } catch {
      known.length = 0
    }

    const knownSet = new Set<string>([...known, ...BUILTIN_TOOLS])
    const tools = definition.tools.filter((name) => knownSet.has(name))
    const dropped = definition.tools.filter((name) => !knownSet.has(name))

    if (tools.length === 0) {
      throw new Error(`subagents: agent "${definition.name}" requested tools [${definition.tools.join(", ")}] but none of them are available`)
    }

    return { tools, dropped }
  }

  async runAgent(definition: AgentDefinition, task: string, context: string | undefined, source: RunnerSource, signal: AbortSignal | undefined, onTurn?: (turns: number) => void, via = "", onTokens?: (tokens: number) => void, limits?: { maxTokens?: number }): Promise<TaskOutcome> {
    const roles = source.roles ?? new RouterRoles(source.cwd)
    const resolved = await resolveModel(definition.model, source, roles)
    const scope = this.resolveToolScope(definition)
    const thinking = definition.thinking !== "" ? definition.thinking : resolved.thinking
    const promptParts = [task.trim()]
    const extra = context?.trim() ?? ""

    if (extra !== "") {
      promptParts.push(`<context>\n${extra}\n</context>`)
    }

    const controller = new AbortController()
    const onParentAbort = (): void => controller.abort()
    signal?.addEventListener("abort", onParentAbort, { once: true })

    if (signal?.aborted) {
      controller.abort()
    }

    const record = this.beginTask(definition.name, via, controller)

    try {
      const result = await this.engine.run({
        label: definition.name,
        systemPrompt: `${definition.prompt}\n\n${YIELD_INSTRUCTION}`,
        prompt: promptParts.join("\n\n"),
        cwd: source.cwd,
        childDepth: this.depth + 1,
        maxTokens: limits?.maxTokens ?? this.config.maxTokens,
        model: resolved.model,
        thinkingLevel: thinking,
        tools: scope.tools,
        modelRegistry: source.modelRegistry,
        signal: controller.signal,
        onTurn: (turns) => {
          record.turns = turns
          this.changed()
          onTurn?.(turns)
        },
        onTokens: (tokens) => {
          record.tokens = tokens
          onTokens?.(tokens)
        },
        onEvent: (kind, text) => this.recordEvent(record, kind, text)
      })
      record.result = result.text
      const summary = result.capped === false ? `completed in ${result.turns} turn${result.turns === 1 ? "" : "s"}` : `stopped at the ${result.capped} cap after ${result.turns} turns`
      this.endTask(record, "done", summary)

      return {
        agent: definition.name,
        model: resolved.id,
        text: result.text,
        turns: result.turns,
        tokens: result.tokens,
        capped: result.capped,
        structured: result.structured,
        dropped: scope.dropped,
        note: result.note
      }
    } catch (error) {
      this.endTask(record, controller.signal.aborted ? "aborted" : "failed", describeError(error))
      throw error
    } finally {
      signal?.removeEventListener("abort", onParentAbort)
    }
  }

  abortJobs(): void {
    for (const job of this.jobs.values()) {
      this.abortController(job.controller)
    }
  }

  startJob(label: string, run: (signal: AbortSignal) => Promise<{ text: string; details: Record<string, unknown> }>): string {
    const id = randomUUID().slice(0, 8)
    const controller = new AbortController()
    this.jobs.set(id, { label, controller })
    void run(controller.signal)
      .then((result) => {
        this.deliver(`[subagents] background job ${id} (${label}) completed:\n\n${result.text}`, { jobId: id, label, status: "completed", ...result.details })
      })
      .catch((error: unknown) => {
        this.deliver(`[subagents] background job ${id} (${label}) failed: ${describeError(error)}`, { jobId: id, label, status: "failed" })
      })
      .finally(() => {
        this.jobs.delete(id)
      })

    return id
  }

  noteContext(ctx: DeliveryContext): void {
    this.deliveryCtx = ctx
  }

  stopDeliveries(): void {
    if (this.deliveryTimer !== undefined) {
      clearInterval(this.deliveryTimer)
      this.deliveryTimer = undefined
    }

    this.outbox.length = 0
  }

  private abortController(controller: AbortController): void {
    try {
      controller.abort()
    } catch {
      return
    }
  }

  private changed(): void {
    try {
      this.onTasksChanged?.()
    } catch {
      return
    }
  }

  private beginTask(agent: string, via: string, controller: AbortController): TaskRecord {
    const record: TaskRecord = {
      id: randomUUID().slice(0, 8),
      agent,
      via,
      state: "running",
      turns: 0,
      tokens: 0,
      startedAt: Date.now(),
      activity: "starting",
      transcript: [{ at: Date.now(), kind: "info", text: "task started" }]
    }
    this.tasks.set(record.id, { record, controller })
    const finished = [...this.tasks.values()].filter((entry) => entry.record.state !== "running")
    const excess = finished.length - Math.max(0, this.config.keepFinished)

    if (excess > 0) {
      finished
        .sort((a, b) => (a.record.endedAt ?? 0) - (b.record.endedAt ?? 0))
        .slice(0, excess)
        .forEach((entry) => this.tasks.delete(entry.record.id))
    }

    this.changed()

    return record
  }

  private recordEvent(record: TaskRecord, kind: "tool" | "text" | "info", text: string): void {
    const flattened = text.replace(/\s+/g, " ").trim()
    const cap = this.activityCap()
    const capped = flattened.length > cap ? `${flattened.slice(0, cap - 1)}…` : flattened
    record.activity = capped
    const previous = record.transcript[record.transcript.length - 1]
    const stored = text.length > TRANSCRIPT_TEXT_CAP ? `${text.slice(0, TRANSCRIPT_TEXT_CAP - 1)}…` : text

    if (previous && previous.kind === kind && previous.text === stored) {
      previous.at = Date.now()
      this.changed()

      return
    }

    record.transcript.push({ at: Date.now(), kind, text: stored })
    const limit = Math.max(10, this.config.transcriptLimit)

    if (record.transcript.length > limit) {
      record.transcript.splice(0, record.transcript.length - limit)
    }

    this.changed()
  }

  private endTask(record: TaskRecord, state: TaskState, summary: string): void {
    record.state = state
    record.endedAt = Date.now()
    record.activity = summary.replace(/\s+/g, " ").trim().slice(0, this.activityCap())
    record.transcript.push({ at: Date.now(), kind: "info", text: summary })
    this.changed()
  }

  private activityCap(): number {
    const cols = process.stdout?.columns

    if (typeof cols === "number" && Number.isFinite(cols) && cols > 0) {
      return Math.max(ACTIVITY_MIN_WIDTH, cols - ACTIVITY_PREFIX_RESERVE)
    }

    return this.config.activityChars
  }

  private deliver(content: string, details: Record<string, unknown>): void {
    const key = randomUUID().slice(0, 8)
    this.outbox.push({ key, content, details: { ...details, deliveryKey: key }, attempts: 0 })
    this.flushDeliveries()
  }

  private confirmedKeys(ctx: DeliveryContext): Set<string> {
    const keys = new Set<string>()

    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== "subagents:result") {
          continue
        }

        const details: unknown = entry.details

        if (isRecord(details) && typeof details.deliveryKey === "string") {
          keys.add(details.deliveryKey)
        }
      }
    } catch {
      return keys
    }

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
          this.notifyDeliveryFailure(ctx)
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

      if (typeof this.deliveryTimer.unref === "function") {
        this.deliveryTimer.unref()
      }
    }

    if (ctx) {
      let idle = false

      try {
        idle = ctx.isIdle()
      } catch {
        idle = false
      }

      if (!idle) {
        return
      }
    }

    const pending = [...this.outbox]

    if (!ctx) {
      this.outbox.length = 0
    }

    for (const item of pending) {
      item.attempts += 1

      try {
        this.sink.sendMessage(
          { customType: "subagents:result", content: item.content, display: true, details: item.details },
          { deliverAs: "followUp", triggerTurn: true }
        )
      } catch {
        continue
      }
    }
  }

  private notifyDeliveryFailure(ctx: DeliveryContext): void {
    try {
      if (ctx.hasUI) {
        ctx.ui.notify(`subagents: a background result could not be delivered after ${DELIVERY_MAX_ATTEMPTS} attempts`, "error")
      }
    } catch {
      return
    }
  }
}
