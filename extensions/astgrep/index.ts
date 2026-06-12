import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerSearch } from "./search.ts"
import { registerRewrite } from "./rewrite.ts"
import type { AstConfig } from "./scan.ts"

const FALLBACK: AstConfig = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepMerge(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
  if (!isRecord(override)) return base
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key]
    if (isRecord(current) && isRecord(value)) merged[key] = deepMerge(current, value)
    else if (value !== undefined) merged[key] = value
  }
  return merged
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function overlayFrom(source: unknown): unknown {
  if (isRecord(source)) return source["astgrep"]
  return undefined
}

function intOr(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function globsOr(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const globs = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
  return globs
}

function langMapOr(value: unknown, fallback: Record<string, string>): Record<string, string> {
  if (!isRecord(value)) return fallback
  const map: Record<string, string> = {}
  for (const [key, lang] of Object.entries(value)) {
    if (typeof lang === "string" && lang.trim() !== "" && key.trim() !== "") {
      map[key.trim().toLowerCase()] = lang.trim()
    }
  }
  if (Object.keys(map).length === 0) return fallback
  return map
}

function sanitize(raw: Record<string, unknown>): AstConfig {
  return {
    fileLimit: intOr(raw.fileLimit, FALLBACK.fileLimit, 1, 100000),
    defaultLimit: intOr(raw.defaultLimit, FALLBACK.defaultLimit, 1, 1000),
    contextLines: intOr(raw.contextLines, FALLBACK.contextLines, 0, 50),
    maxHunks: intOr(raw.maxHunks, FALLBACK.maxHunks, 1, 200),
    maxFileBytes: intOr(raw.maxFileBytes, FALLBACK.maxFileBytes, 1024, 104857600),
    maxStaged: intOr(raw.maxStaged, FALLBACK.maxStaged, 1, 100),
    execTimeout: intOr(raw.execTimeout, FALLBACK.execTimeout, 1000, 120000),
    protectGlobs: globsOr(raw.protectGlobs, FALLBACK.protectGlobs),
    langMap: langMapOr(raw.langMap, FALLBACK.langMap)
  }
}

function loadConfig(): AstConfig {
  let merged: Record<string, unknown> = { ...FALLBACK }
  try {
    const shipped = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))
    merged = deepMerge(merged, shipped)
  } catch {}
  merged = deepMerge(merged, overlayFrom(readJson(join(homedir(), ".pi", "agent", "suite.json"))))
  merged = deepMerge(merged, overlayFrom(readJson(join(process.cwd(), ".pi", "suite.json"))))
  return sanitize(merged)
}

export default function astgrep(pi: ExtensionAPI): void {
  const config = loadConfig()
  registerSearch(pi, config)
  registerRewrite(pi, config)
}
