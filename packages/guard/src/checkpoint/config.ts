export interface CheckpointConfig {
  maxMb: number
  maxAgeDays: number
  labelMaxChars: number
  maxFileMb: number
  maxBashFiles: number
  maxCheckpointFiles: number
  confirmListLimit: number
  bashPatterns: string[]
}

export interface ManifestEntry {
  ts: number
  toolCallId: string
  path: string
  hash: string | null
  size: number
  label: string
}

export interface LabelGroup {
  label: string
  firstIndex: number
  firstTs: number
  lastTs: number
  paths: string[]
  entryCount: number
}

export const FALLBACK: CheckpointConfig = {
  maxMb: 200,
  maxAgeDays: 30,
  labelMaxChars: 64,
  maxFileMb: 25,
  maxBashFiles: 20,
  maxCheckpointFiles: 500,
  confirmListLimit: 20,
  bashPatterns: [
    "\\brm\\s",
    "\\bmv\\s",
    "\\bcp\\s",
    "\\bln\\s",
    "\\btouch\\s",
    "\\bmkdir\\s",
    "\\brmdir\\s",
    "\\btruncate\\s",
    "\\btee\\b",
    "\\bdd\\s",
    "\\bpatch\\b",
    "\\brsync\\s",
    "\\bunzip\\s",
    "\\btar\\s+[^|;]*x",
    ">{1,2}",
    "\\bsed\\b[^|;]*\\s(-i|--in-place)",
    "\\bchmod\\s",
    "\\bchown\\s",
    "\\bgit\\s+(checkout|restore|reset|clean|stash|apply|am|merge|rebase|cherry-pick|revert|pull|mv|rm)\\b",
    "\\bnpm\\s+(install|ci|uninstall|update|prune|dedupe)\\b",
    "\\bpnpm\\s+(install|add|remove|update|prune)\\b",
    "\\byarn\\s+(install|add|remove|upgrade)\\b",
    "\\bbun\\s+(install|add|remove|update)\\b",
    "\\bprettier\\b[^|;]*\\s(--write|-w)\\b",
    "\\beslint\\b[^|;]*\\s--fix\\b",
    "\\bblack\\s",
    "\\bruff\\s+(format|check\\b[^|;]*--fix)",
    "\\bgofmt\\s+[^|;]*-w\\b",
    "\\bcargo\\s+fmt\\b"
  ]
}

type Plain = Record<string, unknown>

export interface ConfigDiagnostics {
  fellBack: string[]
}

export class Config {
  private readonly merged: CheckpointConfig
  readonly diagnostics: ConfigDiagnostics

  constructor(layers: unknown[]) {
    let accumulated: Plain = { ...FALLBACK }

    for (const layer of layers) {
      accumulated = Config.deepMerge(accumulated, layer)
    }

    const diagnostics: ConfigDiagnostics = { fellBack: [] }
    this.merged = Config.sanitize(accumulated, diagnostics)
    this.diagnostics = diagnostics
  }

  get value(): CheckpointConfig {
    return this.merged
  }

  static overlayFrom(source: unknown): unknown {
    if (source && typeof source === "object" && !Array.isArray(source)) {
      return (source as Plain)["checkpoint"]
    }

    return undefined
  }

  static deepMerge(base: Plain, override: unknown): Plain {
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      return base
    }

    const out: Plain = { ...base }

    for (const [key, value] of Object.entries(override as Plain)) {
      const existing = out[key]
      const bothPlain =
        existing !== null &&
        typeof existing === "object" &&
        !Array.isArray(existing) &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)

      if (bothPlain) {
        out[key] = Config.deepMerge(existing as Plain, value)
      } else if (value !== undefined) {
        out[key] = value
      }
    }

    return out
  }

  private static sanitize(raw: Plain, diagnostics: ConfigDiagnostics): CheckpointConfig {
    const num = (key: keyof CheckpointConfig, value: unknown, fallback: number): number => {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value
      }

      diagnostics.fellBack.push(key)

      return fallback
    }

    let patterns: string[]

    if (Array.isArray(raw.bashPatterns)) {
      patterns = raw.bashPatterns.filter((pattern): pattern is string => typeof pattern === "string")
    } else {
      diagnostics.fellBack.push("bashPatterns")
      patterns = FALLBACK.bashPatterns
    }

    return {
      maxMb: num("maxMb", raw.maxMb, FALLBACK.maxMb),
      maxAgeDays: num("maxAgeDays", raw.maxAgeDays, FALLBACK.maxAgeDays),
      labelMaxChars: num("labelMaxChars", raw.labelMaxChars, FALLBACK.labelMaxChars),
      maxFileMb: num("maxFileMb", raw.maxFileMb, FALLBACK.maxFileMb),
      maxBashFiles: num("maxBashFiles", raw.maxBashFiles, FALLBACK.maxBashFiles),
      maxCheckpointFiles: num("maxCheckpointFiles", raw.maxCheckpointFiles, FALLBACK.maxCheckpointFiles),
      confirmListLimit: num("confirmListLimit", raw.confirmListLimit, FALLBACK.confirmListLimit),
      bashPatterns: patterns
    }
  }
}
