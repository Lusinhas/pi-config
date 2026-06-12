import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { THINKING_LEVELS } from "./registry.ts"
import type { AgentDefinition, ThinkingLevel } from "./registry.ts"

export interface SubagentsConfig {
  maxConcurrent: number
  maxDepth: number
  maxTurns: number
  maxTokens: number
  advisorModel: string
  advisorThinking: string
  advisorContextChars: number
  widget: boolean
  widgetLimit: number
  transcriptLimit: number
  activityChars: number
  keepFinished: number
  teams: Record<string, unknown>
}

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

export type CapReason = false | "turns" | "tokens"

export interface LoopResult {
  text: string
  turns: number
  tokens: number
  capped: CapReason
  structured?: unknown
  note?: string
}

export interface LoopOptions {
  label: string
  systemPrompt: string
  prompt: string
  cwd: string
  childDepth: number
  maxTurns: number
  maxTokens: number
  model?: unknown
  thinkingLevel?: ThinkingLevel
  tools?: string[]
  modelRegistry?: unknown
  signal?: AbortSignal
  onTurn?: (turns: number) => void
  onTokens?: (tokens: number) => void
  onEvent?: (kind: "tool" | "text", text: string) => void
}

export interface ModelSource {
  model?: unknown
  modelRegistry?: unknown
}

export interface ResolvedModel {
  model?: unknown
  id: string
  thinking?: ThinkingLevel
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

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"]

const DELIVERY_RETRY_MS = 1000
const DELIVERY_MAX_ATTEMPTS = 30

interface PendingDelivery {
  key: string
  content: string
  details: Record<string, unknown>
  attempts: number
}

const YIELD_INSTRUCTION = "When the task is complete, reply with your final answer as plain text. If structured data belongs in the answer, append it as exactly one fenced ```json code block at the very end of the reply."

const MARKER_KEY = Symbol.for("piconfig.subagents.marker")

interface MarkerState {
  depth: number
  label: string
  lock: Promise<void>
}

function markerState(): MarkerState {
  const host = globalThis as unknown as Record<symbol, MarkerState | undefined>
  let state = host[MARKER_KEY]
  if (!state) {
    state = { depth: 0, label: "", lock: Promise.resolve() }
    host[MARKER_KEY] = state
  }
  if (typeof state.label !== "string") state.label = ""
  return state
}

export function readDepth(): number {
  return markerState().depth
}

export function readLabel(): string {
  return markerState().label
}

async function withDepthMarker<T>(depth: number, label: string, fn: () => Promise<T>): Promise<T> {
  const state = markerState()
  const previous = state.lock
  let release: () => void = () => undefined
  state.lock = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  const restoreDepth = state.depth
  const restoreLabel = state.label
  state.depth = depth
  state.label = label
  try {
    return await fn()
  } finally {
    state.depth = restoreDepth
    state.label = restoreLabel
    release()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asThinking(value: unknown): ThinkingLevel | undefined {
  if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel
  return undefined
}

interface RoleTarget {
  model: string
  thinking?: ThinkingLevel
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function readRouterRoles(cwd: string): Record<string, RoleTarget> {
  const roles: Record<string, RoleTarget> = {}
  const files = [join(homedir(), ".pi", "agent", "suite.json"), join(cwd, ".pi", "suite.json")]
  for (const file of files) {
    const parsed = readJsonFile(file)
    if (!parsed || !isRecord(parsed.router)) continue
    const router = parsed.router
    const source = isRecord(router.roles) ? router.roles : router
    for (const [name, value] of Object.entries(source)) {
      if (typeof value === "string" && value.trim() !== "") {
        roles[name] = { model: value.trim() }
      } else if (isRecord(value) && typeof value.model === "string" && value.model.trim() !== "") {
        roles[name] = { model: value.model.trim(), thinking: asThinking(value.thinking) }
      }
    }
  }
  return roles
}

function describeModel(model: unknown): string {
  if (isRecord(model)) {
    const provider = typeof model.provider === "string" ? model.provider : ""
    const id = typeof model.id === "string" ? model.id : ""
    if (provider !== "" && id !== "") return `${provider}/${id}`
    if (id !== "") return id
  }
  return "inherit"
}

interface RegistryLike {
  find?: (provider: string, modelId: string) => unknown
  getAvailable?: () => Promise<unknown[]>
}

async function findModel(registry: RegistryLike, spec: string): Promise<unknown> {
  if (typeof registry.find === "function" && spec.includes("/")) {
    const separator = spec.indexOf("/")
    try {
      const found = registry.find(spec.slice(0, separator), spec.slice(separator + 1))
      if (found) return found
    } catch {}
  }
  if (typeof registry.getAvailable === "function") {
    let available: unknown[] = []
    try {
      available = await registry.getAvailable()
    } catch {
      available = []
    }
    if (!Array.isArray(available)) return undefined
    for (const candidate of available) {
      if (!isRecord(candidate)) continue
      const id = typeof candidate.id === "string" ? candidate.id : ""
      const provider = typeof candidate.provider === "string" ? candidate.provider : ""
      if (id !== "" && (id === spec || (provider !== "" && `${provider}/${id}` === spec))) return candidate
    }
  }
  return undefined
}

export async function resolveModel(spec: string, source: ModelSource, cwd: string): Promise<ResolvedModel> {
  const requested = spec.trim()
  if (requested === "" || requested.toLowerCase() === "inherit") {
    return { model: source.model, id: describeModel(source.model) }
  }
  const roles = readRouterRoles(cwd)
  const role = roles[requested]
  const target = role ? role.model : requested
  const thinking = role?.thinking
  if (target.toLowerCase() === "inherit") {
    return { model: source.model, id: describeModel(source.model), thinking }
  }
  const registry: RegistryLike = isRecord(source.modelRegistry) ? (source.modelRegistry as RegistryLike) : {}
  const found = await findModel(registry, target)
  if (!found) {
    const via = role ? ` (via role "${requested}")` : ""
    throw new Error(`subagents: model "${target}"${via} was not found in the model registry`)
  }
  return { model: found, id: describeModel(found), thinking }
}

interface SessionLike {
  subscribe?: (listener: (event: Record<string, unknown>) => void) => () => void
  prompt: (text: string) => Promise<void>
  abort?: () => unknown
  dispose?: () => void
  messages?: unknown
  agent?: {
    waitForIdle?: () => Promise<void>
    state?: { messages?: unknown }
  }
}

function extractText(messages: unknown): string {
  if (!Array.isArray(messages)) return ""
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue
    const parts: string[] = []
    for (const block of message.content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text)
    }
    const joined = parts.join("\n").trim()
    if (joined !== "") return joined
  }
  return ""
}

function extractStructured(text: string): unknown {
  const pattern = /```json\s*\n?([\s\S]*?)```/g
  let match: RegExpExecArray | null = pattern.exec(text)
  let last: string | undefined
  while (match !== null) {
    last = match[1]
    match = pattern.exec(text)
  }
  if (last === undefined) return undefined
  try {
    return JSON.parse(last.trim()) as unknown
  } catch {
    return undefined
  }
}

function usageTokens(message: unknown): number {
  if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return 0
  const usage = message.usage
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return usage.totalTokens
  let total = 0
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const value = usage[key]
    if (typeof value === "number" && Number.isFinite(value)) total += value
  }
  return total
}

function extractMessageText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return ""
  const parts: string[] = []
  for (const block of message.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text)
  }
  return parts.join("\n").trim()
}

const TOOLVIEW_KEY = Symbol.for("piconfig.toolview")

function previewArgs(toolName: string, args: unknown): string {
  const host = globalThis as unknown as Record<symbol, unknown>
  const view = host[TOOLVIEW_KEY]
  if (isRecord(view) && typeof view.compact === "function") {
    try {
      const compact = (view.compact as (tool: string, input: unknown) => unknown)(toolName, args)
      if (typeof compact === "string" && compact !== "") return compact
    } catch {}
  }
  if (!isRecord(args)) return ""
  try {
    const rendered = JSON.stringify(args)
    return rendered.length > 100 ? `${rendered.slice(0, 99)}…` : rendered
  } catch {
    return ""
  }
}

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  if (options.signal?.aborted) throw new Error(`${options.label}: aborted before start`)
  const created = await withDepthMarker(options.childDepth, options.label, async () => {
    const loader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
      systemPromptOverride: () => options.systemPrompt
    })
    await loader.reload()
    const sessionOptions: Record<string, unknown> = {
      cwd: options.cwd,
      sessionManager: SessionManager.inMemory(options.cwd),
      resourceLoader: loader
    }
    if (options.modelRegistry !== undefined) sessionOptions.modelRegistry = options.modelRegistry
    if (options.model !== undefined) sessionOptions.model = options.model
    if (options.thinkingLevel !== undefined) sessionOptions.thinkingLevel = options.thinkingLevel
    if (options.tools !== undefined) {
      if (options.tools.length === 0) sessionOptions.noTools = "all"
      else sessionOptions.tools = options.tools
    }
    return await createAgentSession(sessionOptions as Parameters<typeof createAgentSession>[0])
  })
  const createdRecord: Record<string, unknown> = isRecord(created) ? created : {}
  const session = createdRecord.session as SessionLike | undefined
  if (!session || typeof session.prompt !== "function") {
    throw new Error(`${options.label}: failed to create an in-process subagent session`)
  }
  const note = typeof createdRecord.modelFallbackMessage === "string" ? createdRecord.modelFallbackMessage : undefined
  let turns = 0
  let tokens = 0
  let capped: CapReason = false
  let parentAborted = false
  const requestAbort = (): void => {
    if (typeof session.abort !== "function") return
    try {
      void Promise.resolve(session.abort()).catch(() => undefined)
    } catch {}
  }
  let unsubscribe: (() => void) | undefined
  if (typeof session.subscribe === "function") {
    unsubscribe = session.subscribe((event) => {
      if (!isRecord(event)) return
      if (event.type === "turn_end") {
        turns += 1
        try {
          options.onTurn?.(turns)
        } catch {}
        if (options.maxTurns > 0 && turns >= options.maxTurns && capped === false) {
          capped = "turns"
          requestAbort()
        }
      } else if (event.type === "message_end") {
        tokens += usageTokens(event.message)
        try {
          options.onTokens?.(tokens)
        } catch {}
        const text = extractMessageText(event.message)
        if (text !== "") {
          try {
            options.onEvent?.("text", text)
          } catch {}
        }
        if (options.maxTokens > 0 && tokens >= options.maxTokens && capped === false) {
          capped = "tokens"
          requestAbort()
        }
      } else if (event.type === "tool_execution_start") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool"
        const preview = previewArgs(toolName, event.args)
        try {
          options.onEvent?.("tool", preview !== "" ? `${toolName} ${preview}` : toolName)
        } catch {}
      }
    })
  }
  const onAbort = (): void => {
    parentAborted = true
    requestAbort()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  let failed = false
  let runError: unknown
  try {
    await session.prompt(options.prompt)
    if (typeof session.agent?.waitForIdle === "function") await session.agent.waitForIdle()
  } catch (error) {
    failed = true
    runError = error
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch {}
    }
  }
  const messages = Array.isArray(session.messages) ? session.messages : session.agent?.state?.messages
  const text = extractText(messages)
  if (typeof session.dispose === "function") {
    try {
      session.dispose()
    } catch {}
  }
  if (parentAborted) throw new Error(`${options.label}: aborted`)
  if (failed && capped === false) throw new Error(`${options.label}: ${describeError(runError)}`)
  return { text, turns, tokens, capped, structured: extractStructured(text), note }
}

export class Runner {
  readonly depth: number
  private readonly pi: ExtensionAPI
  private readonly config: SubagentsConfig
  private active = 0
  private readonly waiters: Array<() => void> = []
  private readonly jobs = new Map<string, { label: string; controller: AbortController }>()
  private readonly tasks = new Map<string, { record: TaskRecord; controller: AbortController }>()
  private onTasksChanged?: () => void
  private readonly outbox: PendingDelivery[] = []
  private deliveryTimer: ReturnType<typeof setInterval> | undefined
  private deliveryCtx: ExtensionContext | undefined

  constructor(pi: ExtensionAPI, config: SubagentsConfig, depth: number) {
    this.pi = pi
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
    if (!entry) return "missing"
    if (entry.record.state !== "running") return "finished"
    try {
      entry.controller.abort()
    } catch {}
    return "aborted"
  }

  killAll(): void {
    for (const entry of this.tasks.values()) {
      if (entry.record.state !== "running") continue
      try {
        entry.controller.abort()
      } catch {}
    }
  }

  private changed(): void {
    try {
      this.onTasksChanged?.()
    } catch {}
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
    const capped = flattened.length > this.config.activityChars ? `${flattened.slice(0, this.config.activityChars - 1)}…` : flattened
    record.activity = capped
    record.transcript.push({ at: Date.now(), kind, text: text.length > 4000 ? `${text.slice(0, 3999)}…` : text })
    if (record.transcript.length > Math.max(10, this.config.transcriptLimit)) {
      record.transcript.splice(0, record.transcript.length - Math.max(10, this.config.transcriptLimit))
    }
    this.changed()
  }

  private endTask(record: TaskRecord, state: TaskState, summary: string): void {
    record.state = state
    record.endedAt = Date.now()
    record.activity = summary.replace(/\s+/g, " ").trim().slice(0, this.config.activityChars)
    record.transcript.push({ at: Date.now(), kind: "info", text: summary })
    this.changed()
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
      if (next) next()
    }
  }

  resolveToolScope(definition: AgentDefinition): { tools?: string[]; dropped: string[] } {
    if (definition.tools === "all") return { dropped: [] }
    const known: string[] = []
    try {
      const all = this.pi.getAllTools()
      if (Array.isArray(all)) {
        for (const item of all) {
          if (typeof item === "string") known.push(item)
          else if (isRecord(item) && typeof item.name === "string") known.push(item.name)
        }
      }
    } catch {}
    const knownSet = new Set<string>([...known, ...BUILTIN_TOOLS])
    const tools = definition.tools.filter((name) => knownSet.has(name))
    const dropped = definition.tools.filter((name) => !knownSet.has(name))
    if (tools.length === 0) {
      throw new Error(`subagents: agent "${definition.name}" requested tools [${definition.tools.join(", ")}] but none of them are available`)
    }
    return { tools, dropped }
  }

  async runAgent(definition: AgentDefinition, task: string, context: string | undefined, source: ModelSource & { cwd: string }, signal: AbortSignal | undefined, onTurn?: (turns: number) => void, via = "", onTokens?: (tokens: number) => void): Promise<TaskOutcome> {
    const resolved = await resolveModel(definition.model, source, source.cwd)
    const scope = this.resolveToolScope(definition)
    const thinking = definition.thinking !== "" ? definition.thinking : resolved.thinking
    const promptParts = [task.trim()]
    const extra = context?.trim() ?? ""
    if (extra !== "") promptParts.push(`<context>\n${extra}\n</context>`)
    const controller = new AbortController()
    const onParentAbort = (): void => controller.abort()
    signal?.addEventListener("abort", onParentAbort, { once: true })
    if (signal?.aborted) controller.abort()
    const record = this.beginTask(definition.name, via, controller)
    try {
      const result = await runLoop({
        label: definition.name,
        systemPrompt: `${definition.prompt}\n\n${YIELD_INSTRUCTION}`,
        prompt: promptParts.join("\n\n"),
        cwd: source.cwd,
        childDepth: this.depth + 1,
        maxTurns: this.config.maxTurns,
        maxTokens: this.config.maxTokens,
        model: resolved.model,
        thinkingLevel: thinking,
        tools: scope.tools,
        modelRegistry: source.modelRegistry,
        signal: controller.signal,
        onTurn: (turns) => {
          record.turns = turns
          record.activity = `turn ${turns}`
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
      try {
        job.controller.abort()
      } catch {}
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

  noteContext(ctx: ExtensionContext): void {
    this.deliveryCtx = ctx
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
        if (entry.type !== "custom_message" || entry.customType !== "subagents:result") continue
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
            if (ctx.hasUI) ctx.ui.notify(`subagents: a background result could not be delivered after ${DELIVERY_MAX_ATTEMPTS} attempts`, "error")
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
          { customType: "subagents:result", content: item.content, display: true, details: item.details },
          { deliverAs: "followUp", triggerTurn: true }
        )
      } catch {}
    }
  }
}
