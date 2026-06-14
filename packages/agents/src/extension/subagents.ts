import { mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import { createAgentSession, createEventBus, createExtensionRuntime, createSyntheticSourceInfo, discoverAndLoadExtensions, loadProjectContextFiles, SessionManager } from "@earendil-works/pi-coding-agent"
import type { Extension, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ResourceLoader, ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { Runner, readDepth, readLabel } from "../subagents/index.ts"
import type { TaskOutcome } from "../subagents/index.ts"
import { LoopEngine } from "../subagents/engine.ts"
import type { CompactResolver, CreatedSession, SessionCreateOptions, SessionFactory } from "../subagents/engine.ts"
import { loadRegistry } from "../subagents/registry.ts"
import type { AgentDefinition, AgentRegistry } from "../subagents/registry.ts"
import { TeamRunner } from "../subagents/teams.ts"
import type { TeamSource } from "../subagents/teams.ts"
import { Advisor } from "../subagents/advisor.ts"
import { taskReport, ViewerModel, widgetLines } from "../subagents/render.ts"
import type { SubagentsConfig } from "../subagents/config.ts"

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

interface ThemeLike {
  fg?: (color: never, text: string) => string
}

const TOOLVIEW_KEY = Symbol.for("piconfig.toolview")
const USAGE_SINK_KEY = Symbol.for("piconfig.usage.sink")
const PERMISSION_BROKER_KEY = Symbol.for("piconfig.permissions.broker")
const IDE_KEY = Symbol.for("piconfig.ide")

interface PermissionBroker {
  decide(toolName: string, input: unknown, origin: string): Promise<{ block?: boolean; reason?: string } | undefined>
  mode(): string
}

function readBroker(): PermissionBroker | undefined {
  const host = globalThis as unknown as Record<symbol, unknown>
  const candidate = host[PERMISSION_BROKER_KEY]

  if (isRecord(candidate) && typeof candidate.decide === "function" && typeof candidate.mode === "function") {
    return candidate as unknown as PermissionBroker
  }

  return undefined
}

interface IdePreviewBridge {
  previewEdit(req: { toolName: string; args: Record<string, unknown>; toolCallId: string; cwd: string }): Promise<void>
  closePreview(toolCallId: string): Promise<void>
}

function readIde(): IdePreviewBridge | undefined {
  const host = globalThis as unknown as Record<symbol, unknown>
  const candidate = host[IDE_KEY]

  if (isRecord(candidate) && typeof candidate.previewEdit === "function" && typeof candidate.closePreview === "function") {
    return candidate as unknown as IdePreviewBridge
  }

  return undefined
}

class SubagentPermissionGate {
  private readonly origin: string

  constructor(origin: string) {
    this.origin = origin
  }

  extension(extensionPath: string): Extension {
    const handler = (event: { toolName: string; input: unknown }): Promise<ToolCallEventResult | undefined> | undefined => {
      const broker = readBroker()

      if (!broker) {
        return undefined
      }

      return broker.decide(event.toolName, event.input, this.origin)
    }

    const onExecStart = (
      event: { toolName?: unknown; args?: unknown; toolCallId?: unknown },
      ctx: { cwd?: unknown },
    ): undefined => {
      if (event.toolName !== "edit" && event.toolName !== "write") {
        return undefined
      }

      const ide = readIde()

      if (!ide) {
        return undefined
      }

      const args = isRecord(event.args) ? event.args : {}
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : ""
      const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd()

      void ide.previewEdit({ toolName: event.toolName, args, toolCallId, cwd })

      return undefined
    }

    const onExecEnd = (event: { toolName?: unknown; toolCallId?: unknown }): undefined => {
      if (event.toolName !== "edit" && event.toolName !== "write") {
        return undefined
      }

      const ide = readIde()

      if (!ide) {
        return undefined
      }

      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : ""

      void ide.closePreview(toolCallId)

      return undefined
    }

    return {
      path: extensionPath,
      resolvedPath: extensionPath,
      sourceInfo: createSyntheticSourceInfo(extensionPath, { source: "local", baseDir: dirname(extensionPath) }),
      handlers: new Map([
        ["tool_call", [handler]],
        ["tool_execution_start", [onExecStart]],
        ["tool_execution_end", [onExecEnd]]
      ]) as unknown as Extension["handlers"],
      tools: new Map(),
      messageRenderers: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map()
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function paint(theme: ThemeLike | undefined, color: string, text: string): string {
  if (!theme || typeof theme.fg !== "function") {
    return text
  }

  try {
    return theme.fg(color as never, text)
  } catch {
    return text
  }
}

function formatElapsed(startedAt: number): string {
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))

  if (total < 60) {
    return `${total}s`
  }

  const minutes = Math.floor(total / 60)

  if (minutes < 60) {
    return `${minutes}m${total % 60}s`
  }

  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

class SubagentResourceLoader implements ResourceLoader {
  private readonly systemPrompt: string
  private readonly runtime: ReturnType<typeof createExtensionRuntime>
  private readonly extensions: ReturnType<ResourceLoader["getExtensions"]>["extensions"]
  private readonly agentsFiles: ReturnType<ResourceLoader["getAgentsFiles"]>["agentsFiles"]

  constructor(
    cwd: string,
    agentDir: string,
    systemPrompt: string,
    runtime: ReturnType<typeof createExtensionRuntime>,
    extensions: ReturnType<ResourceLoader["getExtensions"]>["extensions"],
  ) {
    this.systemPrompt = systemPrompt
    this.runtime = runtime
    this.extensions = extensions
    this.agentsFiles = loadProjectContextFiles({ cwd, agentDir })
  }

  getExtensions(): ReturnType<ResourceLoader["getExtensions"]> {
    return { extensions: this.extensions, errors: [], runtime: this.runtime }
  }

  getSkills(): ReturnType<ResourceLoader["getSkills"]> {
    return { skills: [], diagnostics: [] }
  }

  getPrompts(): ReturnType<ResourceLoader["getPrompts"]> {
    return { prompts: [], diagnostics: [] }
  }

  getThemes(): ReturnType<ResourceLoader["getThemes"]> {
    return { themes: [], diagnostics: [] }
  }

  getAgentsFiles(): ReturnType<ResourceLoader["getAgentsFiles"]> {
    return { agentsFiles: this.agentsFiles }
  }

  getSystemPrompt(): string | undefined {
    return this.systemPrompt
  }

  getAppendSystemPrompt(): string[] {
    return []
  }

  extendResources(): void {}

  async reload(): Promise<void> {}
}

class ExtraExtensions {
  static #neutralDir: string | null = null

  static #neutral(): string {
    if (ExtraExtensions.#neutralDir === null) {
      const dir = join(tmpdir(), "pi-subagent-extensions")

      mkdirSync(dir, { recursive: true })
      ExtraExtensions.#neutralDir = dir

      return dir
    }

    return ExtraExtensions.#neutralDir
  }

  static async load(): Promise<{ extensions: Extension[]; runtime: ReturnType<typeof createExtensionRuntime> }> {
    try {
      const editingDir = fileURLToPath(new URL("../../../editing", import.meta.url))
      const batchDir = fileURLToPath(new URL("../../../batch", import.meta.url))
      const neutral = ExtraExtensions.#neutral()
      const result = await discoverAndLoadExtensions([editingDir, batchDir], neutral, neutral, createEventBus())

      return { extensions: result.extensions, runtime: result.runtime }
    } catch {
      return { extensions: [], runtime: createExtensionRuntime() }
    }
  }
}

class PiSessionFactory implements SessionFactory {
  async createSession(options: SessionCreateOptions): Promise<CreatedSession> {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")
    const extras = await ExtraExtensions.load()
    const label = readLabel()
    const origin = label !== "" ? label : `subagent depth ${readDepth()}`
    const gate = new SubagentPermissionGate(origin).extension("piconfig:subagent-permission-gate")
    const resourceLoader = new SubagentResourceLoader(options.cwd, agentDir, options.systemPrompt, extras.runtime, [gate, ...extras.extensions])
    const sessionOptions: Record<string, unknown> = {
      cwd: options.cwd,
      sessionManager: SessionManager.inMemory(options.cwd),
      resourceLoader
    }

    if (options.modelRegistry !== undefined) {
      sessionOptions.modelRegistry = options.modelRegistry
    }

    if (options.model !== undefined) {
      sessionOptions.model = options.model
    }

    if (options.thinkingLevel !== undefined) {
      sessionOptions.thinkingLevel = options.thinkingLevel
    }

    if (options.tools !== undefined) {
      if (options.tools.length === 0) {
        sessionOptions.noTools = "all"
      } else {
        sessionOptions.tools = options.tools
      }
    }

    const created = await createAgentSession(sessionOptions as Parameters<typeof createAgentSession>[0])

    return created as CreatedSession
  }
}

function toolviewCompact(): ((toolName: string, input: unknown) => string) | undefined {
  const host = globalThis as unknown as Record<symbol, unknown>
  const view = host[TOOLVIEW_KEY]

  if (!isRecord(view) || typeof view.compact !== "function") {
    return undefined
  }

  const compact = view.compact as (tool: string, input: unknown) => unknown

  return (toolName: string, input: unknown): string => {
    const rendered = compact(toolName, input)

    return typeof rendered === "string" ? rendered : ""
  }
}

function usageForward(message: unknown, model: unknown): void {
  const host = globalThis as unknown as Record<symbol, unknown>
  const sink = host[USAGE_SINK_KEY]

  if (typeof sink !== "function") {
    return
  }

  try {
    ;(sink as (message: unknown, model: unknown) => void)(message, model)
  } catch {
    return
  }
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

  if (outcome.capped === "tokens") {
    notes.push(`stopped at the token cap after ${outcome.tokens} tokens; the result may be incomplete`)
  }

  if (outcome.dropped.length > 0) {
    notes.push(`unavailable tools were skipped: ${outcome.dropped.join(", ")}`)
  }

  if (outcome.note) {
    notes.push(outcome.note)
  }

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

  if (outcome.structured !== undefined) {
    details.structured = outcome.structured
  }

  if (outcome.note) {
    details.note = outcome.note
  }

  return details
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

export class SubagentsRegistrar {
  private readonly pi: ExtensionAPI
  private readonly config: SubagentsConfig
  private readonly engine: LoopEngine
  readonly runner: Runner
  private readonly teamRunner: TeamRunner
  private readonly advisor: Advisor
  private widgetCtx: ExtensionContext | undefined
  private widgetTimer: ReturnType<typeof setTimeout> | undefined
  private widgetTicker: ReturnType<typeof setInterval> | undefined

  constructor(pi: ExtensionAPI, config: SubagentsConfig) {
    this.pi = pi
    this.config = config
    this.engine = new LoopEngine(new PiSessionFactory(), toolviewCompact as CompactResolver)
    const tools = { getAllTools: (): unknown => pi.getAllTools() }
    const sink = {
      sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>): void => {
        pi.sendMessage(message as never, options as never)
      }
    }
    const depth = readDepth()
    this.runner = new Runner(this.engine, tools, sink, config, depth)
    this.teamRunner = new TeamRunner(this.runner)
    this.advisor = new Advisor(this.engine, depth)
  }

  register(): void {
    const pi = this.pi
    const config = this.config
    const initialRegistry = loadRegistry(process.cwd())

    pi.on("message_end", (event, ctx) => {
      if (readDepth() > 0) {
        usageForward((event as { message?: unknown })?.message, ctx.model)
      }

      return undefined
    })

    this.runner.setOnTasksChanged(() => {
      if (this.widgetTimer !== undefined) {
        return
      }

      this.widgetTimer = setTimeout(() => {
        this.widgetTimer = undefined
        this.renderWidget()
      }, 200)
    })

    pi.on("session_start", (_event, ctx) => {
      this.widgetCtx = ctx
      this.runner.noteContext(this.deliveryContext(ctx))
      this.renderWidget()
    })

    pi.on("session_shutdown", () => {
      this.shutdown()
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
      execute: (toolCallId: string, params: TaskParams, signal: AbortSignal | undefined, onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolOutput> => {
        return this.executeTask(params, signal, onUpdate, ctx)
      }
    })

    pi.registerTool({
      name: "advisor",
      label: "Advisor",
      description: "Ask an independent advisor model for a second opinion on the current conversation. The advisor receives a transcript with oversized tool payloads stripped, plus your question, and returns candid advice.",
      parameters: Type.Object({
        question: Type.String({ description: "What you want a second opinion on" })
      }),
      execute: (toolCallId: string, params: AdvisorParams, signal: AbortSignal | undefined, onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolOutput> => {
        return this.executeAdvisor(params, signal, onUpdate, ctx)
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
      handler: (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        return this.handleCommand(args, ctx)
      }
    })
  }

  shutdown(): void {
    if (this.widgetTimer !== undefined) {
      clearTimeout(this.widgetTimer)
      this.widgetTimer = undefined
    }

    this.stopWidgetTicker()

    try {
      this.runner.killAll()
      this.runner.abortJobs()
      this.runner.stopDeliveries()
    } catch {
      return
    }
  }

  private deliveryContext(ctx: ExtensionContext): {
    hasUI: boolean
    isIdle(): boolean
    ui: { notify(message: string, level: "info" | "warning" | "error"): void }
    sessionManager: { getEntries(): unknown[] }
  } {
    return {
      hasUI: ctx.hasUI,
      isIdle: (): boolean => ctx.isIdle(),
      ui: {
        notify: (message: string, level: "info" | "warning" | "error"): void => {
          if (ctx.hasUI) {
            ctx.ui.notify(message, level)
          }
        }
      },
      sessionManager: { getEntries: (): unknown[] => ctx.sessionManager.getEntries() }
    }
  }

  private stopWidgetTicker(): void {
    if (this.widgetTicker !== undefined) {
      clearInterval(this.widgetTicker)
      this.widgetTicker = undefined
    }
  }

  private renderWidget(): void {
    const ctx = this.widgetCtx

    if (!ctx || !this.config.widget || !ctx.hasUI) {
      this.stopWidgetTicker()

      return
    }

    try {
      const theme = ctx.ui.theme as unknown as ThemeLike
      const lines = widgetLines(this.runner.listTasks(), this.config.widgetLimit, (color, text) => paint(theme, color, text))
      ctx.ui.setWidget("subagents", lines.length > 0 ? lines : undefined)

      if (lines.length > 0) {
        if (this.widgetTicker === undefined) {
          this.widgetTicker = setInterval(() => this.renderWidget(), 1000)

          if (typeof this.widgetTicker.unref === "function") {
            this.widgetTicker.unref()
          }
        }
      } else {
        this.stopWidgetTicker()
      }
    } catch {
      this.stopWidgetTicker()
    }
  }

  private async executeTask(params: TaskParams, signal: AbortSignal | undefined, onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolOutput> {
    this.runner.ensureDepth()
    this.runner.noteContext(this.deliveryContext(ctx))
    const agentSpec = (params.agent ?? "").trim()
    const taskText = (params.task ?? "").trim()

    if (agentSpec === "") {
      throw new Error("subagents: the agent parameter is required")
    }

    if (taskText === "") {
      throw new Error("subagents: the task parameter is required")
    }

    const source: TeamSource = { cwd: ctx.cwd, model: ctx.model, modelRegistry: ctx.modelRegistry }
    const startedAt = Date.now()
    let status = ""
    let statusTicker: ReturnType<typeof setInterval> | undefined

    const emitStatus = (): void => {
      if (typeof onUpdate !== "function" || status === "") {
        return
      }

      onUpdate({ content: [{ type: "text", text: `${status} · ${formatElapsed(startedAt)}` }], details: undefined })
    }

    const update = (text: string): void => {
      status = text

      if (statusTicker === undefined && typeof onUpdate === "function") {
        statusTicker = setInterval(emitStatus, 1000)

        if (typeof statusTicker.unref === "function") {
          statusTicker.unref()
        }
      }

      emitStatus()
    }

    try {
      const registry = loadRegistry(ctx.cwd)

      if (agentSpec.startsWith("team:")) {
        return await this.executeTeam(registry, agentSpec, taskText, params, source, signal, update)
      }

      const definition = registry.agents.get(agentSpec)

      if (!definition) {
        const names = [...registry.agents.keys()]
        const available = names.length > 0 ? `Available agents: ${names.join(", ")}.` : `No agent definitions were found (searched: ${registry.paths.join(", ")}).`
        const broken = registry.errors.length > 0 ? ` ${registry.errors.length} definition file(s) failed to parse; run /agents for details.` : ""

        throw new Error(`subagents: unknown agent "${agentSpec}". ${available}${broken}`)
      }

      if (params.background === true) {
        const jobId = this.runner.startJob(definition.name, async (jobSignal) => {
          const outcome = await this.runner.runAgent(definition, taskText, params.context, source, jobSignal, undefined, "background")

          return { text: outcomeText(outcome), details: outcomeDetails(outcome) }
        })

        return {
          content: [{ type: "text", text: `Background job ${jobId} started for agent "${definition.name}". The result will arrive as a follow-up message.` }],
          details: { jobId, agent: definition.name, background: true }
        }
      }

      update(`${definition.name}: starting`)
      const outcome = await this.runner.runAgent(definition, taskText, params.context, source, signal, (turns) => {
        update(`${definition.name}: turn ${turns}`)
      })

      return { content: [{ type: "text", text: outcomeText(outcome) }], details: outcomeDetails(outcome) }
    } finally {
      if (statusTicker !== undefined) {
        clearInterval(statusTicker)
      }
    }
  }

  private async executeTeam(registry: AgentRegistry, agentSpec: string, taskText: string, params: TaskParams, source: TeamSource, signal: AbortSignal | undefined, update: (text: string) => void): Promise<ToolOutput> {
    const teamName = agentSpec.slice("team:".length).trim()
    const raw = teamName === "" ? undefined : this.config.teams[teamName]

    if (raw === undefined) {
      const known = Object.keys(this.config.teams)
      const hint = known.length > 0 ? ` (configured teams: ${known.join(", ")})` : " (no teams are configured under the subagents.teams config key)"

      throw new Error(`subagents: unknown team "${teamName}"${hint}`)
    }

    if (params.background === true) {
      const jobId = this.runner.startJob(`team:${teamName}`, (jobSignal) => this.teamRunner.run(registry, teamName, raw, taskText, params.context, source, jobSignal))

      return {
        content: [{ type: "text", text: `Background job ${jobId} started for team "${teamName}". The merged report will arrive as a follow-up message.` }],
        details: { jobId, team: teamName, background: true }
      }
    }

    update(`team ${teamName}: starting`)
    const result = await this.teamRunner.run(registry, teamName, raw, taskText, params.context, source, signal, update)

    return { content: [{ type: "text", text: result.text }], details: result.details }
  }

  private async executeAdvisor(params: AdvisorParams, signal: AbortSignal | undefined, onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolOutput> {
    const update = (text: string): void => {
      if (typeof onUpdate === "function") {
        onUpdate({ content: [{ type: "text", text }], details: undefined })
      }
    }

    update("advisor: consulting")
    const result = await this.advisor.run(
      params.question ?? "",
      this.config,
      { cwd: ctx.cwd, model: ctx.model, modelRegistry: ctx.modelRegistry, sessionManager: ctx.sessionManager },
      signal,
      (turns) => update(`advisor: turn ${turns}`)
    )

    return { content: [{ type: "text", text: result.text }], details: result.details }
  }

  private async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const registry = loadRegistry(ctx.cwd)
    const requested = args.trim()
    const [verb, ...rest] = requested.split(/\s+/)

    if (verb === "view") {
      if (!ctx.hasUI) {
        return
      }

      this.widgetCtx = ctx
      await this.openViewer(ctx)
      this.renderWidget()

      return
    }

    if (verb === "tasks") {
      if (ctx.hasUI) {
        ctx.ui.notify(taskReport(this.runner.listTasks()), "info")
      }

      return
    }

    if (verb === "kill") {
      const id = rest.join(" ").trim()
      const result = id === "" ? "missing" : this.runner.killTask(id)

      if (ctx.hasUI) {
        if (result === "aborted") {
          ctx.ui.notify(`subagents: task ${id} aborted`, "info")
        } else if (result === "finished") {
          ctx.ui.notify(`subagents: task ${id} already finished`, "warning")
        } else {
          ctx.ui.notify(`subagents: no running task ${id || "(missing id)"}; run /agents tasks to list ids`, "error")
        }
      }

      return
    }

    if (!ctx.hasUI) {
      return
    }

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

    await this.selectAgent(registry, ctx)
  }

  private async selectAgent(registry: AgentRegistry, ctx: ExtensionCommandContext): Promise<void> {
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

    if (choice === undefined) {
      return
    }

    const detail = detailByOption.get(choice)

    if (detail) {
      ctx.ui.notify(detail.text, detail.level)
    }
  }

  private async openViewer(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      return
    }

    const runner = this.runner
    await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => {
      const model = new ViewerModel(runner)
      const refresh = (): void => {
        try {
          tui.requestRender()
        } catch {
          return
        }
      }
      const ticker = setInterval(refresh, 1000)
      const themed = theme as unknown as ThemeLike
      const painter = (color: string, text: string): string => paint(themed, color, text)
      const truncate = (text: string, width: number): string => truncateToWidth(text, width)

      return {
        render(width: number): string[] {
          return model.render(width, painter, truncate)
        },
        handleInput(data: string): void {
          const key = matchesKey(data, "escape")
            ? "escape"
            : data === "q"
              ? "quit"
              : matchesKey(data, "up")
                ? "up"
                : matchesKey(data, "down")
                  ? "down"
                  : matchesKey(data, "enter")
                    ? "enter"
                    : data === "x"
                      ? "kill"
                      : "none"

          if (key === "none") {
            return
          }

          const action = model.handleKey(key)

          if (action.kill !== undefined) {
            runner.killTask(action.kill)
          }

          if (action.close) {
            clearInterval(ticker)
            done(undefined)

            return
          }

          refresh()
        },
        invalidate(): void {},
        dispose(): void {
          clearInterval(ticker)
        }
      }
    })
  }
}
