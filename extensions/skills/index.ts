import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import type { Dirent } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export interface SkillsConfig {
  global: boolean
  project: boolean
  dirs: string[]
}

const defaults: SkillsConfig = {
  global: true,
  project: true,
  dirs: []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readJson(path: string | URL): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalize(raw: Record<string, unknown>): SkillsConfig {
  const dirs = Array.isArray(raw.dirs)
    ? raw.dirs.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [...defaults.dirs]
  return {
    global: typeof raw.global === "boolean" ? raw.global : defaults.global,
    project: typeof raw.project === "boolean" ? raw.project : defaults.project,
    dirs
  }
}

export function loadConfig(cwd: string, trusted: boolean): SkillsConfig {
  let merged: Record<string, unknown> = { ...defaults }
  const shipped = readJson(new URL("./config.json", import.meta.url))
  if (shipped) merged = { ...merged, ...shipped }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "piconfig.json"))
  if (globalConfig && isRecord(globalConfig.skills)) merged = { ...merged, ...globalConfig.skills }
  if (trusted) {
    const projectConfig = readJson(join(cwd, ".pi", "piconfig.json"))
    if (projectConfig && isRecord(projectConfig.skills)) merged = { ...merged, ...projectConfig.skills }
  }
  return normalize(merged)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

export function walkSkillDirs(baseDir: string): string[] {
  const results: string[] = []
  if (!isDirectory(baseDir)) return results
  const stack: string[] = [baseDir]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    if (isFile(join(dir, "SKILL.md"))) {
      results.push(dir)
      continue
    }
    for (const entry of readEntries(dir)) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const full = join(dir, entry.name)
      if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(full))) stack.push(full)
    }
  }
  return results.sort()
}

export function projectSkillBases(cwd: string): string[] {
  const bases: string[] = []
  let dir = resolve(cwd)
  for (;;) {
    bases.push(join(dir, ".claude", "skills"))
    const parent = dirname(dir)
    if (existsSync(join(dir, ".git")) || parent === dir) break
    dir = parent
  }
  return bases
}

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

export function discoverClaudeSkills(cwd: string, trusted: boolean): string[] {
  const config = loadConfig(cwd, trusted)
  const found = new Set<string>()
  if (config.global) {
    for (const dir of walkSkillDirs(join(homedir(), ".claude", "skills"))) found.add(dir)
  }
  if (config.project && trusted) {
    for (const base of projectSkillBases(cwd)) {
      for (const dir of walkSkillDirs(base)) found.add(dir)
    }
  }
  for (const extra of config.dirs) {
    for (const dir of walkSkillDirs(resolve(cwd, expandHome(extra)))) found.add(dir)
  }
  return [...found].sort()
}

export default function skills(pi: ExtensionAPI): void {
  pi.on("resources_discover", (_event, ctx) => {
    let trusted = false
    try {
      trusted = ctx.isProjectTrusted()
    } catch {
      trusted = false
    }
    return { skillPaths: discoverClaudeSkills(ctx.cwd, trusted) }
  })
}
