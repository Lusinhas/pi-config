import { THINKING_LEVELS } from "./registry.ts"
import type { ThinkingLevel } from "./registry.ts"
import { LoopEngine } from "./engine.ts"
import { resolveModel, RouterRoles } from "./model.ts"
import type { ModelSource } from "./model.ts"
import type { SubagentsConfig } from "./config.ts"

export const ADVISOR_PROMPT = "You are an independent senior engineering advisor. You receive a transcript of a coding-agent conversation and a question about it. Give a candid second opinion: judge the current approach, point out risks, mistakes, or missed alternatives, and answer the question directly. Be specific and reference concrete details from the transcript. Do not flatter; if the approach is sound, say so briefly and add what would make it stronger."

const TOOL_PAYLOAD_CAP = 1500
const CALL_PAYLOAD_CAP = 400

export interface AdvisorContext extends ModelSource {
  cwd: string
  sessionManager?: unknown
  roles?: RouterRoles
}

export interface AdvisorResult {
  text: string
  details: Record<string, unknown>
}

export interface EntrySource {
  getBranch?: () => unknown[]
  getEntries?: () => unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }

  return `${text.slice(0, limit)} [+${text.length - limit} chars truncated]`
}

export function renderContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return ""
  }

  return content.map(renderBlock).filter((part) => part !== "").join("\n")
}

export function renderBlock(block: unknown): string {
  if (typeof block === "string") {
    return block
  }

  if (!isRecord(block)) {
    return ""
  }

  if (block.type === "text" && typeof block.text === "string") {
    return block.text
  }

  if (block.type === "thinking") {
    return ""
  }

  if (block.type === "toolCall") {
    const name = typeof block.name === "string" ? block.name : "tool"
    let args = ""

    try {
      args = JSON.stringify(block.arguments ?? block.input ?? {})
    } catch {
      args = "(unserializable arguments)"
    }

    return `[tool call: ${name} ${clip(args, CALL_PAYLOAD_CAP)}]`
  }

  if (block.type === "toolResult" || block.type === "tool_result") {
    return `[tool result: ${clip(renderContent(block.content), TOOL_PAYLOAD_CAP)}]`
  }

  if (block.type === "image") {
    return "[image]"
  }

  return ""
}

export function buildTranscript(entries: unknown[], maxChars: number): string {
  const lines: string[] = []

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue
    }

    if (entry.type === "custom") {
      continue
    }

    let message: Record<string, unknown> | undefined

    if (isRecord(entry.message)) {
      message = entry.message
    } else if (typeof entry.role === "string") {
      message = entry
    }

    if (!message || typeof message.role !== "string") {
      continue
    }

    const role = message.role
    const body = renderContent(message.content)

    if (body.trim() === "") {
      continue
    }

    let label: string

    if (role === "assistant") {
      label = "Assistant"
    } else if (role === "user") {
      label = "User"
    } else if (role === "toolResult" || role === "tool") {
      label = "Tool"
    } else {
      label = role
    }

    const rendered = label === "Tool" ? clip(body, TOOL_PAYLOAD_CAP) : body
    lines.push(`### ${label}\n${rendered.trim()}`)
  }

  let transcript = lines.join("\n\n")

  if (transcript.length > maxChars) {
    transcript = `[transcript truncated to the most recent ${maxChars} characters]\n${transcript.slice(transcript.length - maxChars)}`
  }

  return transcript
}

export function readEntries(sessionManager: unknown): unknown[] {
  if (!isRecord(sessionManager)) {
    return []
  }

  const manager = sessionManager as EntrySource

  try {
    if (typeof manager.getBranch === "function") {
      const branch = manager.getBranch()

      if (Array.isArray(branch)) {
        return branch
      }
    }

    if (typeof manager.getEntries === "function") {
      const entries = manager.getEntries()

      if (Array.isArray(entries)) {
        return entries
      }
    }
  } catch {
    return []
  }

  return []
}

export class Advisor {
  private readonly engine: LoopEngine
  private readonly depth: number

  constructor(engine: LoopEngine, depth: number) {
    this.engine = engine
    this.depth = depth
  }

  async run(question: string, config: SubagentsConfig, ctx: AdvisorContext, signal: AbortSignal | undefined, onTurn?: (turns: number) => void): Promise<AdvisorResult> {
    const trimmed = question.trim()

    if (trimmed === "") {
      throw new Error("advisor: a question is required")
    }

    const entries = readEntries(ctx.sessionManager)
    const transcript = buildTranscript(entries, Math.max(1000, config.advisorContextChars))
    const roles = ctx.roles ?? new RouterRoles(ctx.cwd)
    const resolved = await resolveModel(config.advisorModel, ctx, roles)
    const configured = config.advisorThinking.trim().toLowerCase()
    const fallback: ThinkingLevel = (THINKING_LEVELS as readonly string[]).includes(configured) ? (configured as ThinkingLevel) : "xhigh"
    const intro = transcript === "" ? "(no prior conversation was available)" : `Conversation transcript:\n\n${transcript}`
    const result = await this.engine.run({
      label: "advisor",
      systemPrompt: ADVISOR_PROMPT,
      prompt: `${intro}\n\nQuestion:\n${trimmed}`,
      cwd: ctx.cwd,
      childDepth: this.depth + 1,
      maxTokens: config.maxTokens,
      model: resolved.model,
      thinkingLevel: resolved.thinking ?? fallback,
      tools: [],
      modelRegistry: ctx.modelRegistry,
      signal,
      onTurn
    })

    if (result.text.trim() === "") {
      throw new Error("advisor: the advisor model returned no advice")
    }

    return {
      text: result.text,
      details: {
        model: resolved.id,
        thinking: resolved.thinking ?? fallback,
        turns: result.turns,
        tokens: result.tokens,
        transcriptChars: transcript.length
      }
    }
  }
}
