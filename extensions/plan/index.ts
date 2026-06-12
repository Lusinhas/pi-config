import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
  enterPlan,
  evaluateToolCall,
  exitPlan,
  planSystemPrompt,
  syncFromSession,
  type PlanConfig,
  type PlanState,
} from "./gating"
import { reviewTurn } from "./review"

const FALLBACK: PlanConfig = {
  readonlyTools: ["read", "grep", "find", "ls"],
  extraAllowed: ["websearch", "webfetch", "astsearch", "history", "task", "advisor"],
  blockedTools: ["write", "edit", "bash"],
  systemPrompt:
    "You are in plan mode. Explore the codebase and design an approach, but do not modify files, create files, or run anything that changes the workspace. Work only with the read-only tools currently available. Finish your response by presenting a concrete implementation plan as a numbered list under a 'Plan' heading, then stop and wait for approval.",
  blockReason:
    "Plan mode is active: this tool can modify the workspace and is blocked. Keep exploring with read-only tools and finish by presenting a plan.",
  statusText: "plan",
  showWidget: true,
  approveMessage:
    "The plan you presented has been approved. Plan mode is off and full tool access is restored. Implement the approved plan now, following its steps in order.",
  refinePrefix:
    "The plan needs revision before approval. Stay in plan mode, do not modify files, and present an updated plan that addresses this feedback: ",
  review: {
    enabled: true,
    timeoutMs: 120000,
    minLength: 80,
    keywords: ["plan"],
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = result[key]
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMerge(current, value)
    } else if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function normalizeConfig(merged: Record<string, unknown>): PlanConfig {
  const review = isRecord(merged.review) ? merged.review : {}
  return {
    readonlyTools: stringList(merged.readonlyTools, FALLBACK.readonlyTools),
    extraAllowed: stringList(merged.extraAllowed, FALLBACK.extraAllowed),
    blockedTools: stringList(merged.blockedTools, FALLBACK.blockedTools),
    systemPrompt: text(merged.systemPrompt, FALLBACK.systemPrompt),
    blockReason: text(merged.blockReason, FALLBACK.blockReason),
    statusText: text(merged.statusText, FALLBACK.statusText),
    showWidget: flag(merged.showWidget, FALLBACK.showWidget),
    approveMessage: text(merged.approveMessage, FALLBACK.approveMessage),
    refinePrefix: text(merged.refinePrefix, FALLBACK.refinePrefix),
    review: {
      enabled: flag(review.enabled, FALLBACK.review.enabled),
      timeoutMs: count(review.timeoutMs, FALLBACK.review.timeoutMs),
      minLength: count(review.minLength, FALLBACK.review.minLength),
      keywords: stringList(review.keywords, FALLBACK.review.keywords),
    },
  }
}

function loadConfig(): PlanConfig {
  let merged: Record<string, unknown> = {}
  try {
    const raw = readFileSync(new URL("./config.json", import.meta.url), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed)) merged = parsed
  } catch {
    merged = {}
  }
  const overridePaths = [join(homedir(), ".pi", "agent", "suite.json"), join(process.cwd(), ".pi", "suite.json")]
  for (const path of overridePaths) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (isRecord(parsed) && isRecord(parsed.plan)) merged = deepMerge(merged, parsed.plan)
    } catch {
      continue
    }
  }
  return normalizeConfig(merged)
}

export default function plan(pi: ExtensionAPI): void {
  const config = loadConfig()
  const state: PlanState = { active: false, snapshot: [], gated: [], reviewing: false }

  function describeGated(): string {
    return state.gated.length > 0 ? "allowed tools: " + state.gated.join(", ") : "no read-only tools available"
  }

  async function turnOn(ctx: ExtensionContext): Promise<void> {
    const entered = await enterPlan(pi, ctx, config, state, true)
    if (!ctx.hasUI) return
    if (entered) ctx.ui.notify("plan mode on; " + describeGated(), "info")
    else ctx.ui.notify("plan mode is already on", "info")
  }

  async function turnOff(ctx: ExtensionContext): Promise<void> {
    const exited = await exitPlan(pi, ctx, config, state, true)
    if (!ctx.hasUI) return
    if (exited) ctx.ui.notify("plan mode off; tool access restored", "info")
    else ctx.ui.notify("plan mode is already off", "info")
  }

  function show(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return
    if (state.active) ctx.ui.notify("plan mode is on; " + describeGated(), "info")
    else ctx.ui.notify("plan mode is off", "info")
  }

  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only tool gating): /plan, /plan on, /plan off, /plan show",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const arg = (args ?? "").trim().toLowerCase()
      try {
        if (arg === "" || arg === "toggle") {
          if (state.active) await turnOff(ctx)
          else await turnOn(ctx)
        } else if (arg === "on" || arg === "enter" || arg === "start") {
          await turnOn(ctx)
        } else if (arg === "off" || arg === "exit" || arg === "stop") {
          await turnOff(ctx)
        } else if (arg === "show" || arg === "status") {
          show(ctx)
        } else if (ctx.hasUI) {
          ctx.ui.notify("usage: /plan [on|off|show]", "warning")
        }
      } catch {
        if (ctx.hasUI) ctx.ui.notify("plan command failed", "error")
      }
    },
    getArgumentCompletions: (argument: string) => {
      const prefix = (argument ?? "").trim().toLowerCase()
      const matches = ["on", "off", "show"].filter((option) => option.startsWith(prefix))
      return matches.length > 0 ? matches.map((option) => ({ value: option, label: option })) : null
    },
  })

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    try {
      await syncFromSession(pi, ctx, config, state)
    } catch {
      return
    }
  })

  pi.on("before_agent_start", (event) => {
    if (!state.active) return undefined
    return { systemPrompt: planSystemPrompt(event.systemPrompt, config.systemPrompt) }
  })

  pi.on("tool_call", (event: { toolName?: unknown }) => evaluateToolCall(config, state, event.toolName))

  pi.on("turn_end", async (event: { message?: unknown; toolResults?: unknown }, ctx: ExtensionContext) => {
    try {
      await reviewTurn(pi, ctx, config, state, event)
    } catch {
      return
    }
  })
}
