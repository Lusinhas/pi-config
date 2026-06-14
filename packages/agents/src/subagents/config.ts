export interface SubagentsConfig {
  maxConcurrent: number
  maxDepth: number
  maxTokens: number
  advisorModel: string
  advisorThinking: string
  advisorContextChars: number
  widget: boolean
  widgetLimit: number
  transcriptLimit: number
  activityChars: number
  keepFinished: number
  teams: Record<string, unknown>
}

export const DEFAULT_CONFIG: SubagentsConfig = {
  maxConcurrent: 4,
  maxDepth: 2,
  maxTokens: 0,
  advisorModel: "",
  advisorThinking: "xhigh",
  advisorContextChars: 60000,
  widget: true,
  widgetLimit: 4,
  transcriptLimit: 60,
  activityChars: 100,
  keepFinished: 20,
  teams: {}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(override)) {
    const current = merged[key]

    if (isRecord(current) && isRecord(value)) {
      merged[key] = deepMerge(current, value)
    } else if (value !== undefined) {
      merged[key] = value
    }
  }

  return merged
}

export function toCount(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback
  }

  const rounded = Math.floor(value)

  return rounded < minimum ? minimum : rounded
}

export class Config {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return isRecord(value)
  }

  static deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    return deepMerge(base, override)
  }

  static toCount(value: unknown, fallback: number, minimum: number): number {
    return toCount(value, fallback, minimum)
  }

  static section(source: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (isRecord(source) && isRecord(source.subagents)) {
      return source.subagents
    }

    return null
  }

  static fromLayers(shipped: Record<string, unknown> | null | undefined, homeOverride: Record<string, unknown> | null | undefined, projectOverride: Record<string, unknown> | null | undefined): SubagentsConfig {
    let merged: Record<string, unknown> = { ...DEFAULT_CONFIG }

    if (isRecord(shipped)) {
      merged = deepMerge(merged, shipped)
    }

    const homeSection = Config.section(homeOverride)

    if (homeSection) {
      merged = deepMerge(merged, homeSection)
    }

    const projectSection = Config.section(projectOverride)

    if (projectSection) {
      merged = deepMerge(merged, projectSection)
    }

    return Config.normalize(merged)
  }

  static normalize(raw: Record<string, unknown>): SubagentsConfig {
    return {
      maxConcurrent: toCount(raw.maxConcurrent, DEFAULT_CONFIG.maxConcurrent, 1),
      maxDepth: toCount(raw.maxDepth, DEFAULT_CONFIG.maxDepth, 0),
      maxTokens: toCount(raw.maxTokens, DEFAULT_CONFIG.maxTokens, 0),
      advisorModel: typeof raw.advisorModel === "string" ? raw.advisorModel : DEFAULT_CONFIG.advisorModel,
      advisorThinking: typeof raw.advisorThinking === "string" ? raw.advisorThinking : DEFAULT_CONFIG.advisorThinking,
      advisorContextChars: toCount(raw.advisorContextChars, DEFAULT_CONFIG.advisorContextChars, 1000),
      widget: raw.widget !== false,
      widgetLimit: toCount(raw.widgetLimit, DEFAULT_CONFIG.widgetLimit, 1),
      transcriptLimit: toCount(raw.transcriptLimit, DEFAULT_CONFIG.transcriptLimit, 10),
      activityChars: toCount(raw.activityChars, DEFAULT_CONFIG.activityChars, 20),
      keepFinished: toCount(raw.keepFinished, DEFAULT_CONFIG.keepFinished, 0),
      teams: isRecord(raw.teams) ? raw.teams : { ...DEFAULT_CONFIG.teams }
    }
  }
}
