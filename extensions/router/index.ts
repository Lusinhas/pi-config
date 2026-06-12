import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerEffort } from "./effort"
import { isRecord } from "./models"
import { parseRoles, registerRoles } from "./roles"
import type { RoleTarget } from "./roles"
import { parseFallback, registerFallback } from "./fallback"
import type { FallbackConfig } from "./fallback"
import { parseProfiles, registerProfiles } from "./profiles"
import type { ProfileSpec } from "./profiles"

interface RouterConfig {
  roles: Record<string, RoleTarget>
  fallback: FallbackConfig
  profiles: Record<string, ProfileSpec>
  maxBudgetTokens: number
}

function deepMerge(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
  if (!isRecord(override)) return base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key]
    if (isRecord(existing) && isRecord(value)) {
      out[key] = deepMerge(existing, value)
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
  if (isRecord(source)) return source.router
  return undefined
}

function loadConfig(): RouterConfig {
  let merged: Record<string, unknown> = {}
  try {
    const shipped: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))
    if (isRecord(shipped)) merged = deepMerge(merged, shipped)
  } catch {}
  merged = deepMerge(merged, overlayFrom(readJson(join(homedir(), ".pi", "agent", "suite.json"))))
  merged = deepMerge(merged, overlayFrom(readJson(join(process.cwd(), ".pi", "suite.json"))))
  const budget = merged.maxBudgetTokens
  return {
    roles: parseRoles(merged.roles),
    fallback: parseFallback(merged.fallback),
    profiles: parseProfiles(merged.profiles),
    maxBudgetTokens: typeof budget === "number" && Number.isFinite(budget) && budget >= 1024 ? Math.floor(budget) : 100000
  }
}

export default function router(pi: ExtensionAPI): void {
  const config = loadConfig()
  registerRoles(pi, config.roles)
  registerProfiles(pi, config.profiles)
  registerFallback(pi, config.fallback)
  registerEffort(pi, { maxBudgetTokens: config.maxBudgetTokens })
}
