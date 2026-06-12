import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

export type AgentModel = NonNullable<ExtensionContext["model"]>

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asThinking(value: unknown): ThinkingLevel | undefined {
  if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
    return value as ThinkingLevel
  }
  return undefined
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ModelFields {
  id?: unknown
  provider?: unknown
  name?: unknown
}

function idOf(model: AgentModel): string {
  const fields = model as unknown as ModelFields
  return typeof fields.id === "string" ? fields.id : ""
}

function providerOf(model: AgentModel): string {
  const fields = model as unknown as ModelFields
  return typeof fields.provider === "string" ? fields.provider : ""
}

function nameOf(model: AgentModel): string {
  const fields = model as unknown as ModelFields
  return typeof fields.name === "string" ? fields.name : ""
}

export function describeModel(model: AgentModel | null | undefined): string {
  if (!model) return "unknown"
  const provider = providerOf(model)
  const id = idOf(model)
  if (provider !== "" && id !== "") return `${provider}/${id}`
  if (id !== "") return id
  return "unknown"
}

export function sameModel(a: AgentModel, b: AgentModel): boolean {
  return idOf(a) === idOf(b) && providerOf(a) === providerOf(b)
}

interface RegistryLike {
  getAll?: () => unknown
  getAvailable?: () => unknown
}

export async function listModels(registry: unknown): Promise<AgentModel[]> {
  if (!isRecord(registry)) return []
  const surface = registry as RegistryLike
  for (const method of [surface.getAll, surface.getAvailable]) {
    if (typeof method !== "function") continue
    try {
      const result: unknown = await Promise.resolve(method.call(registry))
      if (!Array.isArray(result)) continue
      const models = result.filter(
        (entry): entry is AgentModel => isRecord(entry) && typeof entry.id === "string" && entry.id !== ""
      )
      if (models.length > 0) return models
    } catch {}
  }
  return []
}

export interface Resolution {
  model?: AgentModel
  matches: AgentModel[]
  suggestions: string[]
}

function suggestionsFor(needle: string, models: AgentModel[]): string[] {
  const ids = models.map((model) => describeModel(model)).filter((id) => id !== "unknown")
  if (needle === "") return ids.slice(0, 5)
  const tokens = needle.split(/[\s/_-]+/).filter((token) => token.length > 1)
  const scored = ids
    .map((id) => {
      const lower = id.toLowerCase()
      let score = 0
      for (const token of tokens) {
        if (lower.includes(token)) score += token.length
      }
      return { id, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.id)
  return scored.length > 0 ? scored : ids.slice(0, 5)
}

export async function resolveModel(registry: unknown, query: string): Promise<Resolution> {
  const needle = query.trim().toLowerCase()
  const models = await listModels(registry)
  if (needle === "" || models.length === 0) {
    return { matches: [], suggestions: suggestionsFor(needle, models) }
  }
  const exact = models.filter((model) => {
    const id = idOf(model).toLowerCase()
    const full = `${providerOf(model)}/${idOf(model)}`.toLowerCase()
    const name = nameOf(model).toLowerCase()
    return id === needle || full === needle || (name !== "" && name === needle)
  })
  if (exact.length > 0) return { model: exact[0], matches: exact, suggestions: [] }
  const partial = models.filter((model) => {
    const haystack = `${providerOf(model)}/${idOf(model)} ${nameOf(model)}`.toLowerCase()
    return haystack.includes(needle)
  })
  if (partial.length > 0) return { model: partial[0], matches: partial, suggestions: [] }
  return { matches: [], suggestions: suggestionsFor(needle, models) }
}

export function notify(ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    try {
      ctx.ui.notify(text, kind)
      return
    } catch {}
  }
  console.log(text)
}
