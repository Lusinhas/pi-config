import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

export interface ReviewConfig {
  enabled: boolean
  timeoutMs: number
  minLength: number
  keywords: string[]
}

export interface PlanConfig {
  readonlyTools: string[]
  extraAllowed: string[]
  blockedTools: string[]
  systemPrompt: string
  blockReason: string
  statusText: string
  showWidget: boolean
  approveMessage: string
  refinePrefix: string
  review: ReviewConfig
}

export interface PlanState {
  active: boolean
  snapshot: string[]
  gated: string[]
  reviewing: boolean
}

export interface PersistedPlan {
  active: boolean
  snapshot: string[]
  gated: string[]
}

export const STATETYPE = "piconfig:plan:state"

function onlyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === "string" && item.length > 0 && !out.includes(item)) out.push(item)
  }
  return out
}

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const item of value) {
    if (typeof item === "string" && item.length > 0 && !names.includes(item)) {
      names.push(item)
    } else if (item && typeof item === "object") {
      const record = item as { name?: unknown }
      if (typeof record.name === "string" && record.name.length > 0 && !names.includes(record.name)) {
        names.push(record.name)
      }
    }
  }
  return names
}

function allToolNames(pi: ExtensionAPI): string[] {
  try {
    return normalizeNames(pi.getAllTools())
  } catch {
    return []
  }
}

function activeToolNames(pi: ExtensionAPI): string[] {
  try {
    return normalizeNames(pi.getActiveTools())
  } catch {
    return []
  }
}

export function computeGated(pi: ExtensionAPI, config: PlanConfig): string[] {
  const existing = new Set(allToolNames(pi))
  const gated: string[] = []
  for (const name of [...config.readonlyTools, ...config.extraAllowed]) {
    if (existing.has(name) && !gated.includes(name)) gated.push(name)
  }
  return gated
}

function persistState(pi: ExtensionAPI, state: PlanState): void {
  try {
    pi.appendEntry(STATETYPE, {
      active: state.active,
      snapshot: [...state.snapshot],
      gated: [...state.gated],
      at: new Date().toISOString(),
    })
  } catch {
    return
  }
}

function widgetLines(state: PlanState): string[] {
  const allowed = state.gated.length > 0 ? state.gated.join(", ") : "none"
  return ["plan mode: read-only gating active", "allowed tools: " + allowed]
}

export function applyUi(ctx: ExtensionContext, config: PlanConfig, state: PlanState): void {
  if (!ctx.hasUI) return
  try {
    if (state.active) {
      ctx.ui.setStatus("plan", config.statusText)
      if (config.showWidget) {
        ctx.ui.setWidget("plan", widgetLines(state), { placement: "belowEditor" })
      } else {
        ctx.ui.setWidget("plan", undefined)
      }
    } else {
      ctx.ui.setStatus("plan", undefined)
      ctx.ui.setWidget("plan", undefined)
    }
  } catch {
    return
  }
}

export async function enterPlan(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: PlanConfig,
  state: PlanState,
  persist: boolean,
): Promise<boolean> {
  if (state.active) return false
  const snapshot = activeToolNames(pi)
  const gated = computeGated(pi, config)
  await pi.setActiveTools(gated)
  state.active = true
  state.snapshot = snapshot
  state.gated = gated
  state.reviewing = false
  if (persist) persistState(pi, state)
  applyUi(ctx, config, state)
  return true
}

export async function exitPlan(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: PlanConfig,
  state: PlanState,
  persist: boolean,
): Promise<boolean> {
  if (!state.active) return false
  const existing = new Set(allToolNames(pi))
  const restorable = state.snapshot.filter((name) => existing.has(name))
  const target = restorable.length > 0 ? restorable : allToolNames(pi)
  await pi.setActiveTools(target)
  state.active = false
  state.snapshot = []
  state.gated = []
  state.reviewing = false
  if (persist) persistState(pi, state)
  applyUi(ctx, config, state)
  return true
}

export function readPersisted(ctx: ExtensionContext): PersistedPlan | undefined {
  try {
    const entries = ctx.sessionManager.getEntries() as unknown
    if (!Array.isArray(entries)) return undefined
    let latest: PersistedPlan | undefined
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue
      const entry = raw as { type?: unknown; customType?: unknown; data?: unknown }
      if (entry.type !== "custom" || entry.customType !== STATETYPE) continue
      const data = entry.data
      if (!data || typeof data !== "object" || Array.isArray(data)) continue
      const record = data as { active?: unknown; snapshot?: unknown; gated?: unknown }
      latest = {
        active: record.active === true,
        snapshot: onlyStrings(record.snapshot),
        gated: onlyStrings(record.gated),
      }
    }
    return latest
  } catch {
    return undefined
  }
}

export async function syncFromSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: PlanConfig,
  state: PlanState,
): Promise<void> {
  const persisted = readPersisted(ctx)
  if (persisted !== undefined && persisted.active) {
    const existing = new Set(allToolNames(pi))
    const restorable = persisted.snapshot.filter((name) => existing.has(name))
    const snapshot =
      restorable.length > 0 ? restorable : state.active ? [...state.snapshot] : activeToolNames(pi)
    const gated = computeGated(pi, config)
    await pi.setActiveTools(gated)
    state.active = true
    state.snapshot = snapshot
    state.gated = gated
    state.reviewing = false
    applyUi(ctx, config, state)
  } else if (state.active) {
    await exitPlan(pi, ctx, config, state, false)
  } else {
    state.reviewing = false
    applyUi(ctx, config, state)
  }
}

export function planSystemPrompt(current: unknown, addendum: string): string {
  if (Array.isArray(current)) {
    const parts = current.filter((part): part is string => typeof part === "string")
    return [...parts, addendum].join("\n\n")
  }
  if (typeof current === "string" && current.trim().length > 0) {
    return current + "\n\n" + addendum
  }
  return addendum
}

export function evaluateToolCall(
  config: PlanConfig,
  state: PlanState,
  toolName: unknown,
): { block: true; reason: string } | undefined {
  if (!state.active) return undefined
  if (typeof toolName !== "string") return undefined
  if (config.blockedTools.includes(toolName)) {
    return { block: true, reason: config.blockReason }
  }
  return undefined
}
