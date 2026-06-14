import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface UsageConfig {
  statsDays: number
  costDecimals: number
}

export interface SanitizeResult {
  value: UsageConfig
  fellBack: string[]
}

export const FALLBACK: UsageConfig = {
  statsDays: 30,
  costDecimals: 4
}

export function deepMerge(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
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

export function overlayFrom(source: unknown): unknown {
  if (source && typeof source === "object" && !Array.isArray(source)) {
    return (source as Record<string, unknown>)["usage"]
  }

  return undefined
}

export function sanitizeConfig(raw: Record<string, unknown>): SanitizeResult {
  const fellBack: string[] = []
  let statsDays = FALLBACK.statsDays

  if (typeof raw.statsDays === "number" && Number.isFinite(raw.statsDays) && raw.statsDays >= 1) {
    statsDays = Math.floor(raw.statsDays)
  } else {
    fellBack.push("statsDays")
  }

  let costDecimals = FALLBACK.costDecimals

  if (
    typeof raw.costDecimals === "number" &&
    Number.isFinite(raw.costDecimals) &&
    raw.costDecimals >= 0 &&
    raw.costDecimals <= 8
  ) {
    costDecimals = Math.floor(raw.costDecimals)
  } else {
    fellBack.push("costDecimals")
  }

  return { value: { statsDays, costDecimals }, fellBack }
}

function readJson(path: string | URL): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

export function loadConfig(): UsageConfig {
  let merged: Record<string, unknown> = { ...FALLBACK }
  const shipped = readJson(new URL("../../config.json", import.meta.url))

  if (shipped !== undefined) merged = deepMerge(merged, overlayFrom(shipped) ?? shipped)

  merged = deepMerge(merged, overlayFrom(readJson(join(homedir(), ".pi", "agent", "suite.json"))))
  merged = deepMerge(merged, overlayFrom(readJson(join(process.cwd(), ".pi", "suite.json"))))

  return sanitizeConfig(merged).value
}
