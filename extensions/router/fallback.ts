import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { describeModel, isRecord, listModels, notify, resolveModel, sameModel } from "./models"
import type { AgentModel } from "./models"

export interface FallbackConfig {
  enabled: boolean
  threshold: number
  failWindowSec: number
  restoreAfterMin: number
  chains: Record<string, string[]>
}

const DEFAULTS: FallbackConfig = {
  enabled: true,
  threshold: 2,
  failWindowSec: 120,
  restoreAfterMin: 10,
  chains: {}
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

export function parseFallback(raw: unknown): FallbackConfig {
  if (!isRecord(raw)) return { ...DEFAULTS, chains: { ...DEFAULTS.chains } }
  const chains: Record<string, string[]> = {}
  if (isRecord(raw.chains)) {
    for (const [pattern, value] of Object.entries(raw.chains)) {
      if (pattern.trim() === "" || !Array.isArray(value)) continue
      const chain = value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .map((entry) => entry.trim())
      if (chain.length > 0) chains[pattern.trim()] = chain
    }
  }
  const threshold = Math.floor(positiveNumber(raw.threshold, DEFAULTS.threshold))
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    threshold: Math.max(1, threshold),
    failWindowSec: positiveNumber(raw.failWindowSec, DEFAULTS.failWindowSec),
    restoreAfterMin: positiveNumber(raw.restoreAfterMin, DEFAULTS.restoreAfterMin),
    chains
  }
}

interface FailureRecord {
  count: number
  last: number
}

interface ActiveFallback {
  original: AgentModel
  fallbackId: string
  streakStart: number
  offered: boolean
}

interface ProviderResponseEvent {
  status?: unknown
  headers?: unknown
}

interface ModelSelectEvent {
  model?: unknown
  previousModel?: unknown
  source?: unknown
}

function statusOf(event: ProviderResponseEvent | undefined): number | undefined {
  const value = event?.status
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function registerFallback(pi: ExtensionAPI, config: FallbackConfig): void {
  if (!config.enabled) return
  const failures = new Map<string, FailureRecord>()
  let active: ActiveFallback | null = null
  let busy = false

  const chainFor = (modelId: string): string[] | undefined => {
    const lower = modelId.toLowerCase()
    for (const [pattern, chain] of Object.entries(config.chains)) {
      if (lower.includes(pattern.toLowerCase())) return chain
    }
    return undefined
  }

  const attemptFallback = async (ctx: ExtensionContext, failedId: string, status: number): Promise<void> => {
    const current = ctx.model
    if (!current) return
    const chain = chainFor(failedId)
    if (!chain) {
      notify(ctx, `router: ${failedId} failed ${config.threshold}x (HTTP ${status}) but no fallback chain matches it`, "warning")
      return
    }
    const original = active ? active.original : current
    let start = 0
    for (let index = 0; index < chain.length; index += 1) {
      const resolution = await resolveModel(ctx.modelRegistry, chain[index])
      if (resolution.model && sameModel(resolution.model, current)) {
        start = index + 1
        break
      }
    }
    const now = Date.now()
    for (let index = start; index < chain.length; index += 1) {
      const resolution = await resolveModel(ctx.modelRegistry, chain[index])
      const candidate = resolution.model
      if (!candidate || sameModel(candidate, current)) continue
      const candidateId = describeModel(candidate)
      const record = failures.get(candidateId)
      if (record && record.count >= config.threshold && now - record.last <= config.failWindowSec * 1000) continue
      let ok = false
      try {
        ok = await pi.setModel(candidate)
      } catch {
        ok = false
      }
      if (!ok) continue
      active = { original, fallbackId: candidateId, streakStart: 0, offered: false }
      notify(
        ctx,
        `router: ${failedId} failed ${config.threshold}x (last HTTP ${status}) — fell back to ${candidateId}; ${describeModel(original)} will be offered back after ${config.restoreAfterMin} min of stable turns`,
        "warning"
      )
      return
    }
    notify(ctx, `router: ${failedId} keeps failing (HTTP ${status}) and no model in its fallback chain could be activated`, "error")
  }

  pi.on("session_start", () => {
    failures.clear()
    active = null
  })

  pi.on("model_select", (event: ModelSelectEvent) => {
    if (busy) return
    failures.clear()
    if (!active) return
    const model = isRecord(event?.model) ? (event.model as unknown as AgentModel) : undefined
    if (!model) return
    if (describeModel(model) === active.fallbackId) return
    active = null
  })

  pi.on("after_provider_response", async (event: ProviderResponseEvent, ctx: ExtensionContext) => {
    const status = statusOf(event)
    if (status === undefined) return
    const modelId = describeModel(ctx.model)
    if (modelId === "unknown") return
    const now = Date.now()
    if (status === 429 || (status >= 500 && status < 600)) {
      const previous = failures.get(modelId)
      const count = previous && now - previous.last <= config.failWindowSec * 1000 ? previous.count + 1 : 1
      failures.set(modelId, { count, last: now })
      if (active && active.fallbackId === modelId) {
        active.streakStart = 0
        active.offered = false
      }
      if (count >= config.threshold && !busy) {
        busy = true
        failures.delete(modelId)
        try {
          await attemptFallback(ctx, modelId, status)
        } finally {
          busy = false
        }
      }
    } else if (status >= 200 && status < 300) {
      failures.delete(modelId)
      if (active && active.fallbackId === modelId && active.streakStart === 0) {
        active.streakStart = now
      }
    }
  })

  pi.on("turn_end", async (_event: unknown, ctx: ExtensionContext) => {
    if (!active || active.offered || active.streakStart === 0 || busy) return
    if (Date.now() - active.streakStart < config.restoreAfterMin * 60 * 1000) return
    busy = true
    const pending = active
    pending.offered = true
    try {
      const models = await listModels(ctx.modelRegistry)
      const live = models.find((model) => sameModel(model, pending.original)) ?? pending.original
      const originalId = describeModel(live)
      let approved = true
      if (ctx.hasUI) {
        approved = await ctx.ui.confirm(
          "Restore model",
          `${pending.fallbackId} has been stable for ${config.restoreAfterMin} min since the provider fallback. Restore ${originalId}?`
        )
      }
      if (!approved) {
        active = null
        return
      }
      let ok = false
      try {
        ok = await pi.setModel(live)
      } catch {
        ok = false
      }
      if (ok) {
        active = null
        failures.delete(originalId)
        notify(ctx, `router: restored ${originalId} after the provider recovered`, "info")
      } else {
        notify(ctx, `router: could not restore ${originalId}; staying on ${pending.fallbackId}`, "warning")
      }
    } finally {
      busy = false
    }
  })
}
