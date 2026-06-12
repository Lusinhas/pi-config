import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { appendHistory, UsageTracker } from "./track"
import { renderSession, renderStats } from "./report"

interface UsageConfig {
  statsDays: number
  costDecimals: number
}

interface MessageEndEvent {
  message?: unknown
}

const FALLBACK: UsageConfig = {
  statsDays: 30,
  costDecimals: 4
}

const SINK_KEY = Symbol.for("piconfig.usage.sink")
const SUBAGENT_MARKER_KEY = Symbol.for("piconfig.subagents.marker")

function subagentDepth(): number {
  const host = globalThis as unknown as Record<symbol, unknown>
  const state = host[SUBAGENT_MARKER_KEY]
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const depth = (state as Record<string, unknown>).depth
    if (typeof depth === "number" && Number.isFinite(depth)) return depth
  }
  return 0
}

function deepMerge(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const existing = out[key]
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function overlayFrom(source: unknown): unknown {
  if (source && typeof source === "object" && !Array.isArray(source)) {
    return (source as Record<string, unknown>)["usage"]
  }
  return undefined
}

function sanitizeConfig(raw: Record<string, unknown>): UsageConfig {
  const statsDays =
    typeof raw.statsDays === "number" && Number.isFinite(raw.statsDays) && raw.statsDays >= 1
      ? Math.floor(raw.statsDays)
      : FALLBACK.statsDays
  const costDecimals =
    typeof raw.costDecimals === "number" &&
    Number.isFinite(raw.costDecimals) &&
    raw.costDecimals >= 0 &&
    raw.costDecimals <= 8
      ? Math.floor(raw.costDecimals)
      : FALLBACK.costDecimals
  return { statsDays, costDecimals }
}

function loadConfig(): UsageConfig {
  let merged: Record<string, unknown> = { ...FALLBACK }
  try {
    const shipped = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))
    merged = deepMerge(merged, shipped)
  } catch {}
  merged = deepMerge(merged, overlayFrom(readJson(join(homedir(), ".pi", "agent", "suite.json"))))
  merged = deepMerge(merged, overlayFrom(readJson(join(process.cwd(), ".pi", "suite.json"))))
  return sanitizeConfig(merged)
}

function activeModelId(ctx: ExtensionContext): string {
  const model: unknown = ctx.model
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const id = (model as Record<string, unknown>).id
    if (typeof id === "string" && id.trim()) return id.trim()
  }
  return "unknown"
}

function sessionFileOf(ctx: ExtensionContext): string {
  try {
    const file: unknown = ctx.sessionManager.getSessionFile()
    return typeof file === "string" ? file : ""
  } catch {
    return ""
  }
}

function restoreFromEntries(tracker: UsageTracker, ctx: ExtensionContext): void {
  let entries: unknown
  try {
    entries = ctx.sessionManager.getEntries()
  } catch {
    return
  }
  if (!Array.isArray(entries)) return
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    if (record.type !== "custom" || record.customType !== "usage") continue
    const data = record.data !== undefined ? record.data : record.details
    if (tracker.restore(data)) return
  }
}

function deliver(ctx: ExtensionCommandContext, text: string): void {
  if (ctx.hasUI) ctx.ui.notify(text, "info")
  else console.log(text)
}

export default function usage(pi: ExtensionAPI): void {
  const host = globalThis as unknown as Record<symbol, unknown>
  if (subagentDepth() > 0) {
    pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
      const sink = host[SINK_KEY]
      if (typeof sink === "function") {
        try {
          ;(sink as (message: unknown, model: unknown) => void)(event?.message, ctx.model)
        } catch {}
      }
      return undefined
    })
    return
  }
  const config = loadConfig()
  const tracker = new UsageTracker()
  const sink = (message: unknown, model: unknown): void => {
    tracker.record(message, model)
  }
  host[SINK_KEY] = sink

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    tracker.reset()
    restoreFromEntries(tracker, ctx)
  })

  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    try {
      tracker.record(event?.message, ctx.model)
    } catch {}
    return undefined
  })

  pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
    try {
      pi.events.emit("piconfig:usage", tracker.endTurn(activeModelId(ctx)))
    } catch {}
  })

  pi.on("agent_end", () => {
    if (!tracker.hasData()) return
    try {
      pi.appendEntry("usage", tracker.snapshot())
    } catch {}
  })

  pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
    if (host[SINK_KEY] === sink) delete host[SINK_KEY]
    if (!tracker.hasNewData()) return
    try {
      const delta = tracker.delta()
      appendHistory({
        date: new Date().toISOString(),
        sessionFile: sessionFileOf(ctx),
        models: delta.models,
        totals: delta.totals
      })
    } catch {}
  })

  pi.registerCommand("usage", {
    description: "Show token and cost usage for the current session, per model",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      deliver(ctx, renderSession(tracker.snapshot(), config.costDecimals))
    }
  })

  pi.registerCommand("stats", {
    description: `Aggregate global usage history into daily and per-model tables (last ${config.statsDays} days)`,
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      deliver(ctx, renderStats(config.statsDays, config.costDecimals))
    }
  })
}
