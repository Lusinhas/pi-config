import type { ThinkingLevel } from "./registry.ts"
import { withDepthMarker } from "./model.ts"

export type CapReason = false | "tokens"

export interface LoopResult {
  text: string
  turns: number
  tokens: number
  capped: CapReason
  structured?: unknown
  note?: string
}

export interface SessionLike {
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

export interface CreatedSession {
  session?: SessionLike
  modelFallbackMessage?: string
}

export interface SessionCreateOptions {
  cwd: string
  systemPrompt: string
  model?: unknown
  modelRegistry?: unknown
  thinkingLevel?: ThinkingLevel
  tools?: string[]
}

export interface SessionFactory {
  createSession(options: SessionCreateOptions): Promise<CreatedSession>
}

export type CompactResolver = () => ((toolName: string, input: unknown) => string) | undefined

export interface LoopOptions {
  label: string
  systemPrompt: string
  prompt: string
  cwd: string
  childDepth: number
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

export const YIELD_INSTRUCTION = "When the task is complete, reply with your final answer as plain text. If structured data belongs in the answer, append it as exactly one fenced ```json code block at the very end of the reply."

const PREVIEW_CAP = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function extractText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return ""
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]

    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue
    }

    const parts: string[] = []

    for (const block of message.content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text)
      }
    }

    const joined = parts.join("\n").trim()

    if (joined !== "") {
      return joined
    }
  }

  return ""
}

export function extractStructured(text: string): unknown {
  const pattern = /```json\s*\n?([\s\S]*?)```/g
  let match: RegExpExecArray | null = pattern.exec(text)
  let last: string | undefined

  while (match !== null) {
    last = match[1]
    match = pattern.exec(text)
  }

  if (last === undefined) {
    return undefined
  }

  try {
    return JSON.parse(last.trim()) as unknown
  } catch {
    return undefined
  }
}

export function usageTokens(message: unknown): number {
  if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) {
    return 0
  }

  const usage = message.usage
  let total = 0
  let counted = false

  for (const key of ["input", "output", "cacheWrite"]) {
    const value = usage[key]

    if (typeof value === "number" && Number.isFinite(value)) {
      total += value
      counted = true
    }
  }

  if (counted) {
    return total
  }

  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
    return usage.totalTokens
  }

  return total
}

export function extractMessageText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return ""
  }

  const parts: string[] = []

  for (const block of message.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    }
  }

  return parts.join("\n").trim()
}

function clipPreview(args: unknown): string {
  if (!isRecord(args)) {
    return ""
  }

  try {
    const rendered = JSON.stringify(args)

    return rendered.length > PREVIEW_CAP ? `${rendered.slice(0, PREVIEW_CAP - 1)}…` : rendered
  } catch {
    return ""
  }
}

export class LoopEngine {
  private readonly factory: SessionFactory
  private readonly compactResolver: CompactResolver

  constructor(factory: SessionFactory, compactResolver: CompactResolver) {
    this.factory = factory
    this.compactResolver = compactResolver
  }

  private preview(compact: ((toolName: string, input: unknown) => string) | undefined, toolName: string, args: unknown): string {
    if (compact) {
      try {
        const rendered = compact(toolName, args)

        if (typeof rendered === "string" && rendered !== "") {
          return rendered
        }
      } catch {
        return clipPreview(args)
      }
    }

    return clipPreview(args)
  }

  async run(options: LoopOptions): Promise<LoopResult> {
    if (options.signal?.aborted) {
      throw new Error(`${options.label}: aborted before start`)
    }

    const created = await withDepthMarker(options.childDepth, options.label, () => this.factory.createSession({
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      model: options.model,
      modelRegistry: options.modelRegistry,
      thinkingLevel: options.thinkingLevel,
      tools: options.tools
    }))
    const session = created.session

    if (!session || typeof session.prompt !== "function") {
      throw new Error(`${options.label}: failed to create an in-process subagent session`)
    }

    const note = typeof created.modelFallbackMessage === "string" ? created.modelFallbackMessage : undefined
    const compact = this.compactResolver()
    let turns = 0
    let tokens = 0
    let capped: CapReason = false
    let parentAborted = false
    let lastEvent = ""

    const emit = (kind: "tool" | "text", text: string): void => {
      const fingerprint = `${kind}\0${text}`

      if (fingerprint === lastEvent) {
        return
      }

      lastEvent = fingerprint
      this.safeCall(() => options.onEvent?.(kind, text))
    }

    const requestAbort = (): void => {
      if (typeof session.abort !== "function") {
        return
      }

      try {
        void Promise.resolve(session.abort()).catch(() => undefined)
      } catch {
        return
      }
    }

    let unsubscribe: (() => void) | undefined

    if (typeof session.subscribe === "function") {
      unsubscribe = session.subscribe((event) => {
        if (!isRecord(event)) {
          return
        }

        if (event.type === "turn_end") {
          turns += 1
          this.safeCall(() => options.onTurn?.(turns))

          return
        }

        if (event.type === "message_end") {
          tokens += usageTokens(event.message)
          this.safeCall(() => options.onTokens?.(tokens))
          const text = extractMessageText(event.message)

          if (text !== "") {
            emit("text", text)
          }

          if (options.maxTokens > 0 && tokens >= options.maxTokens && capped === false) {
            capped = "tokens"
            requestAbort()
          }

          return
        }

        if (event.type === "tool_execution_start") {
          const toolName = typeof event.toolName === "string" ? event.toolName : "tool"
          const preview = this.preview(compact, toolName, event.args)
          emit("tool", preview !== "" ? `${toolName} ${preview}` : toolName)
        }
      })
    }

    const onAbort = (): void => {
      parentAborted = true
      requestAbort()
    }

    options.signal?.addEventListener("abort", onAbort, { once: true })

    if (options.signal?.aborted) {
      onAbort()
    }

    let failed = false
    let runError: unknown

    try {
      await session.prompt(options.prompt)

      if (typeof session.agent?.waitForIdle === "function") {
        await session.agent.waitForIdle()
      }
    } catch (error) {
      failed = true
      runError = error
    } finally {
      options.signal?.removeEventListener("abort", onAbort)

      if (unsubscribe) {
        this.safeCall(unsubscribe)
      }
    }

    const messages = Array.isArray(session.messages) ? session.messages : session.agent?.state?.messages
    const text = extractText(messages)

    if (typeof session.dispose === "function") {
      this.safeCall(() => session.dispose?.())
    }

    if (parentAborted) {
      throw new Error(`${options.label}: aborted`)
    }

    if (failed && capped === false) {
      throw new Error(`${options.label}: ${describeError(runError)}`)
    }

    return { text, turns, tokens, capped, structured: extractStructured(text), note }
  }

  private safeCall(fn: () => void): void {
    try {
      fn()
    } catch {
      return
    }
  }
}
