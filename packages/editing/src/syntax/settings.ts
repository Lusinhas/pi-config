export interface AstConfig {
  fileLimit: number
  defaultLimit: number
  contextLines: number
  maxHunks: number
  maxFileBytes: number
  maxStaged: number
  execTimeout: number
  protectGlobs: string[]
  langMap: Record<string, string>
}

export class Defaults {
  static readonly fallback: AstConfig = {
    fileLimit: 2000,
    defaultLimit: 50,
    contextLines: 2,
    maxHunks: 20,
    maxFileBytes: 1048576,
    maxStaged: 8,
    execTimeout: 10000,
    protectGlobs: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "**/target/**",
      "**/vendor/**",
      "**/coverage/**",
      "**/.next/**",
      "**/__generated__/**",
      "**/*.generated.*",
      "**/*.min.js",
      "**/*.min.css",
      "**/package-lock.json",
      "**/pnpm-lock.yaml",
      "**/yarn.lock",
      "**/Cargo.lock",
      "**/go.sum"
    ],
    langMap: {
      ts: "TypeScript",
      mts: "TypeScript",
      cts: "TypeScript",
      tsx: "Tsx",
      js: "JavaScript",
      mjs: "JavaScript",
      cjs: "JavaScript",
      jsx: "JavaScript",
      py: "Python",
      pyi: "Python",
      rs: "Rust",
      go: "Go",
      java: "Java",
      c: "C",
      h: "C",
      cpp: "Cpp",
      cc: "Cpp",
      cxx: "Cpp",
      hpp: "Cpp",
      hh: "Cpp",
      cs: "CSharp",
      rb: "Ruby",
      kt: "Kotlin",
      kts: "Kotlin",
      swift: "Swift",
      html: "Html",
      htm: "Html",
      css: "Css",
      json: "Json",
      yaml: "Yaml",
      yml: "Yaml"
    }
  }
}

export class Sanitizer {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  static deepMerge(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
    if (!Sanitizer.isRecord(override)) {
      return base
    }

    const merged: Record<string, unknown> = { ...base }

    for (const [key, value] of Object.entries(override)) {
      const current = merged[key]

      if (Sanitizer.isRecord(current) && Sanitizer.isRecord(value)) {
        merged[key] = Sanitizer.deepMerge(current, value)
      } else if (value !== undefined) {
        merged[key] = value
      }
    }

    return merged
  }

  resolve(raw: Record<string, unknown>): AstConfig {
    const fallback = Defaults.fallback

    return {
      fileLimit: this.intOr(raw.fileLimit, fallback.fileLimit, 1, 100000),
      defaultLimit: this.intOr(raw.defaultLimit, fallback.defaultLimit, 1, 1000),
      contextLines: this.intOr(raw.contextLines, fallback.contextLines, 0, 50),
      maxHunks: this.intOr(raw.maxHunks, fallback.maxHunks, 1, 200),
      maxFileBytes: this.intOr(raw.maxFileBytes, fallback.maxFileBytes, 1024, 104857600),
      maxStaged: this.intOr(raw.maxStaged, fallback.maxStaged, 1, 100),
      execTimeout: this.intOr(raw.execTimeout, fallback.execTimeout, 1000, 120000),
      protectGlobs: this.globsOr(raw.protectGlobs, fallback.protectGlobs),
      langMap: this.langMapOr(raw.langMap, fallback.langMap)
    }
  }

  private intOr(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback
    }

    return Math.min(max, Math.max(min, Math.floor(value)))
  }

  private globsOr(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) {
      return fallback
    }

    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
  }

  private langMapOr(value: unknown, fallback: Record<string, string>): Record<string, string> {
    if (!Sanitizer.isRecord(value)) {
      return fallback
    }

    const map: Record<string, string> = {}

    for (const [key, lang] of Object.entries(value)) {
      if (typeof lang === "string" && lang.trim() !== "" && key.trim() !== "") {
        map[key.trim().toLowerCase()] = lang.trim()
      }
    }

    if (Object.keys(map).length === 0) {
      return fallback
    }

    return map
  }
}

export class Config {
  static readonly fallback: AstConfig = Defaults.fallback

  private readonly merged: Record<string, unknown>
  private readonly sanitizer: Sanitizer

  constructor(layers: unknown[]) {
    let merged: Record<string, unknown> = { ...Defaults.fallback }

    for (const layer of layers) {
      merged = Sanitizer.deepMerge(merged, layer)
    }

    this.merged = merged
    this.sanitizer = new Sanitizer()
  }

  static overlay(source: unknown): unknown {
    if (Sanitizer.isRecord(source)) {
      return source["astgrep"]
    }

    return undefined
  }

  static langChoices(map: Record<string, string>): string[] {
    return [...new Set(Object.values(map))].sort()
  }

  resolve(): AstConfig {
    return this.sanitizer.resolve(this.merged)
  }
}
