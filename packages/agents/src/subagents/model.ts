import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { THINKING_LEVELS } from "./registry.ts"
import type { ThinkingLevel } from "./registry.ts"

export interface ModelSource {
  model?: unknown
  modelRegistry?: unknown
}

export interface ResolvedModel {
  model?: unknown
  id: string
  thinking?: ThinkingLevel
}

interface RoleTarget {
  model: string
  thinking?: ThinkingLevel
}

interface RegistryLike {
  find?: (provider: string, modelId: string) => unknown
  getAvailable?: () => Promise<unknown[]>
}

const MARKER_KEY = Symbol.for("piconfig.subagents.marker")
const LOCK_KEY = Symbol.for("piconfig.subagents.marker.lock")

interface MarkerState {
  depth: number
  label: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function markerState(): MarkerState {
  const host = globalThis as unknown as Record<symbol, MarkerState | undefined>
  let state = host[MARKER_KEY]

  if (!state) {
    state = { depth: 0, label: "" }
    host[MARKER_KEY] = state
  }

  if (typeof state.label !== "string") {
    state.label = ""
  }

  return state
}

function markerLock(): Promise<void> {
  const host = globalThis as unknown as Record<symbol, Promise<void> | undefined>

  return host[LOCK_KEY] ?? Promise.resolve()
}

function setMarkerLock(lock: Promise<void>): void {
  const host = globalThis as unknown as Record<symbol, Promise<void> | undefined>
  host[LOCK_KEY] = lock
}

export function readDepth(): number {
  return markerState().depth
}

export function readLabel(): string {
  return markerState().label
}

export async function withDepthMarker<T>(depth: number, label: string, fn: () => Promise<T>): Promise<T> {
  const state = markerState()
  const previous = markerLock()
  let release: () => void = () => undefined
  setMarkerLock(new Promise<void>((resolve) => {
    release = resolve
  }))
  await previous
  const restoreDepth = state.depth
  const restoreLabel = state.label
  state.depth = depth
  state.label = label

  try {
    return await fn()
  } finally {
    state.depth = restoreDepth
    state.label = restoreLabel
    release()
  }
}

function asThinking(value: unknown): ThinkingLevel | undefined {
  if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
    return value as ThinkingLevel
  }

  return undefined
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))

    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export class RouterRoles {
  private readonly cwd: string
  private cached: Record<string, RoleTarget> | undefined

  constructor(cwd: string) {
    this.cwd = cwd
  }

  roles(): Record<string, RoleTarget> {
    if (this.cached) {
      return this.cached
    }

    const roles: Record<string, RoleTarget> = {}
    const files = [join(homedir(), ".pi", "agent", "suite.json"), join(this.cwd, ".pi", "suite.json")]

    for (const file of files) {
      const parsed = readJsonFile(file)

      if (!parsed || !isRecord(parsed.router)) {
        continue
      }

      const router = parsed.router
      const source = isRecord(router.roles) ? router.roles : router

      for (const [name, value] of Object.entries(source)) {
        if (typeof value === "string" && value.trim() !== "") {
          roles[name] = { model: value.trim() }
        } else if (isRecord(value) && typeof value.model === "string" && value.model.trim() !== "") {
          roles[name] = { model: value.model.trim(), thinking: asThinking(value.thinking) }
        }
      }
    }

    this.cached = roles

    return roles
  }
}

export function describeModel(model: unknown): string {
  if (isRecord(model)) {
    const provider = typeof model.provider === "string" ? model.provider : ""
    const id = typeof model.id === "string" ? model.id : ""

    if (provider !== "" && id !== "") {
      return `${provider}/${id}`
    }

    if (id !== "") {
      return id
    }
  }

  return "inherit"
}

function findInRegistry(registry: RegistryLike, provider: string, modelId: string): unknown {
  if (typeof registry.find !== "function") {
    return undefined
  }

  try {
    return registry.find(provider, modelId) ?? undefined
  } catch {
    return undefined
  }
}

export async function findModel(registry: RegistryLike, spec: string): Promise<unknown> {
  if (typeof registry.find === "function" && spec.includes("/")) {
    const separator = spec.indexOf("/")
    const found = findInRegistry(registry, spec.slice(0, separator), spec.slice(separator + 1))

    if (found !== undefined) {
      return found
    }
  }

  if (typeof registry.getAvailable === "function") {
    let available: unknown[] = []

    try {
      available = await registry.getAvailable()
    } catch {
      available = []
    }

    if (!Array.isArray(available)) {
      return undefined
    }

    for (const candidate of available) {
      if (!isRecord(candidate)) {
        continue
      }

      const id = typeof candidate.id === "string" ? candidate.id : ""
      const provider = typeof candidate.provider === "string" ? candidate.provider : ""

      if (id !== "" && (id === spec || (provider !== "" && `${provider}/${id}` === spec))) {
        return candidate
      }
    }
  }

  return undefined
}

export async function resolveModel(spec: string, source: ModelSource, roles: RouterRoles): Promise<ResolvedModel> {
  const requested = spec.trim()

  if (requested === "" || requested.toLowerCase() === "inherit") {
    return { model: source.model, id: describeModel(source.model) }
  }

  const role = roles.roles()[requested]
  const target = role ? role.model : requested
  const thinking = role?.thinking

  if (target.toLowerCase() === "inherit") {
    return { model: source.model, id: describeModel(source.model), thinking }
  }

  const registry: RegistryLike = isRecord(source.modelRegistry) ? (source.modelRegistry as RegistryLike) : {}
  const found = await findModel(registry, target)

  if (!found) {
    const via = role ? ` (via role "${requested}")` : ""

    throw new Error(`subagents: model "${target}"${via} was not found in the model registry`)
  }

  return { model: found, id: describeModel(found), thinking }
}
