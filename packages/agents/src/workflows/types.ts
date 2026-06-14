export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"

export interface AgentDefinition {
  name: string
  description: string
  model: string
  tools: "all" | string[]
  thinking: ThinkingLevel | ""
  prompt: string
  source: string
}

export interface AgentParseError {
  source: string
  reason: string
}

export interface AgentRegistry {
  agents: Map<string, AgentDefinition>
  errors: AgentParseError[]
  paths: string[]
}

export interface ModelSource {
  model?: unknown
  modelRegistry?: unknown
}

export type CapReason = false | "tokens"

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

export interface RunnerLike {
  ensureDepth(): void
  withSlot<T>(fn: () => Promise<T>): Promise<T>
  runAgent(
    definition: AgentDefinition,
    task: string,
    context: string | undefined,
    source: ModelSource & { cwd: string },
    signal: AbortSignal | undefined,
    onTurn?: (turns: number) => void,
    via?: string,
    onTokens?: (tokens: number) => void,
    limits?: { maxTokens?: number }
  ): Promise<TaskOutcome>
}

export type RegistryLoader = (cwd: string) => AgentRegistry

export interface RunContext {
  cwd: string
  hasUI: boolean
  model: unknown
  modelRegistry: unknown
  isProjectTrusted(): boolean
  isIdle(): boolean
  getEntries(): unknown[]
  notify(message: string, level: "info" | "warning" | "error"): void
}

export interface DeliveryMessage {
  customType: "workflows:result"
  content: string
  display: true
  details: Record<string, unknown>
}

export interface RunEntry {
  id: string
  name: string
  agentCount: number
  state: string
  startedAt: number
  endedAt: number
}

export interface WorkflowsHost {
  appendRun(entry: RunEntry): void
  sendResult(message: DeliveryMessage): void
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
  maxTokens?: number
  maxAgents?: number
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
  maxAgents?: number
  maxTokens?: number
}

export interface ToolText {
  type: "text"
  text: string
}

export interface ToolOutput {
  content: ToolText[]
  details: Record<string, unknown> | undefined
}

export type ToolUpdate = ((partial: ToolOutput) => void) | undefined

export interface HistoryRun {
  id: string
  name: string
  agentCount: number
  state: string
  startedAt: number
  endedAt: number
}

export interface SavedScript {
  name: string
  path: string
  description: string
  error: string
}

export interface PendingDelivery {
  key: string
  content: string
  details: Record<string, unknown>
  attempts: number
}

export interface ScriptCacheEntry {
  mtimeMs: number
  description: string
  error: string
}

export interface CachedOutcome {
  text?: string
  structured?: unknown
  turns: number
  tokens: number
}
