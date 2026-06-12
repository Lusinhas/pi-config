import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { exitPlan, type PlanConfig, type PlanState } from "./gating"

export const APPROVEDTYPE = "piconfig:plan:approved"

const HEADING = /^\s{0,3}#{1,6}\s+\S/m

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return ""
  const record = message as { role?: unknown; content?: unknown }
  if (typeof record.role === "string" && record.role !== "assistant") return ""
  const content = record.content
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const piece = block as { type?: unknown; text?: unknown }
    if (piece.type === "text" && typeof piece.text === "string") parts.push(piece.text)
  }
  return parts.join("\n").trim()
}

export function looksLikePlan(text: string, config: PlanConfig): boolean {
  if (text.length < config.review.minLength) return false
  if (HEADING.test(text)) return true
  for (const keyword of config.review.keywords) {
    const trimmed = keyword.trim()
    if (trimmed.length === 0) continue
    const pattern = new RegExp("\\b" + escapeRegExp(trimmed) + "\\b", "i")
    if (pattern.test(text)) return true
  }
  return false
}

export async function reviewTurn(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: PlanConfig,
  state: PlanState,
  payload: { message?: unknown; toolResults?: unknown },
): Promise<void> {
  if (!state.active || state.reviewing) return
  if (!config.review.enabled) return
  if (!ctx.hasUI) return
  if (Array.isArray(payload.toolResults) && payload.toolResults.length > 0) return
  const text = extractAssistantText(payload.message)
  if (!looksLikePlan(text, config)) return
  state.reviewing = true
  try {
    const dialogOptions = config.review.timeoutMs > 0 ? { timeout: config.review.timeoutMs } : undefined
    const choice = await ctx.ui.select(
      "Plan mode: review the proposed plan",
      ["approve", "refine", "discard"],
      dialogOptions,
    )
    if (!state.active) return
    if (choice === "approve") {
      try {
        pi.appendEntry(APPROVEDTYPE, { text, approvedAt: new Date().toISOString() })
      } catch {
        void 0
      }
      await exitPlan(pi, ctx, config, state, true)
      pi.sendMessage(
        { customType: "piconfig:plan:approve", content: config.approveMessage, display: true },
        { deliverAs: "steer", triggerTurn: true },
      )
    } else if (choice === "refine") {
      const feedback = await ctx.ui.input("Refine the plan", "Describe what should change")
      if (!state.active) return
      const trimmed = typeof feedback === "string" ? feedback.trim() : ""
      if (trimmed.length > 0) {
        pi.sendMessage(
          { customType: "piconfig:plan:refine", content: config.refinePrefix + trimmed, display: true },
          { deliverAs: "followUp", triggerTurn: true },
        )
      }
    } else if (choice === "discard") {
      await exitPlan(pi, ctx, config, state, true)
    }
  } finally {
    state.reviewing = false
  }
}
