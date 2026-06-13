import { readdirSync, statSync } from "node:fs"
import type { Dirent } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export interface LoaderConfig {
  prompts: boolean
  skills: boolean
  exclude: string[]
}

export interface DiscoveredResources {
  promptPaths?: string[]
  themePaths?: string[]
  skillPaths?: string[]
}

export const defaultConfig: LoaderConfig = {
  prompts: true,
  skills: true,
  exclude: []
}

export function resolvePackageRoot(): string {
  return resolve(fileURLToPath(new URL("../..", import.meta.url)))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function isExcluded(relPath: string, exclude: string[]): boolean {
  if (exclude.length === 0) return false
  const normalized = relPath.split(sep).join("/")
  for (const pattern of exclude) {
    if (typeof pattern !== "string" || pattern.length === 0) continue
    if (pattern.includes("*")) {
      const source = pattern.split("*").map(escapeRegExp).join(".*")
      if (new RegExp(source).test(normalized)) return true
    } else if (normalized.includes(pattern)) {
      return true
    }
  }
  return false
}

function shouldSkipDir(name: string): boolean {
  return name.startsWith(".") || name === "node_modules"
}

export function isDirectory(path: string): boolean {
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

export function walkFiles(
  baseDir: string,
  root: string,
  exclude: string[],
  matches: (name: string) => boolean
): string[] {
  const results: string[] = []
  if (!isDirectory(baseDir)) return results
  const stack: string[] = [baseDir]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    for (const entry of readEntries(dir)) {
      const full = join(dir, entry.name)
      if (isExcluded(relative(root, full), exclude)) continue
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) stack.push(full)
      } else if (matches(entry.name) && (entry.isFile() || (entry.isSymbolicLink() && isFile(full)))) {
        results.push(full)
      }
    }
  }
  return results.sort()
}

export function walkSkillDirs(baseDir: string, root: string, exclude: string[]): string[] {
  const results: string[] = []
  if (!isDirectory(baseDir)) return results
  const stack: string[] = [baseDir]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    for (const entry of readEntries(dir)) {
      const full = join(dir, entry.name)
      if (isExcluded(relative(root, full), exclude)) continue
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) stack.push(full)
      } else if (
        entry.name === "SKILL.md" &&
        dir !== baseDir &&
        (entry.isFile() || (entry.isSymbolicLink() && isFile(full)))
      ) {
        results.push(dir)
      }
    }
  }
  return results.sort()
}

export function discover(root: string, config: LoaderConfig): DiscoveredResources {
  const result: DiscoveredResources = {}
  if (config.prompts) {
    result.promptPaths = walkFiles(join(root, "prompts"), root, config.exclude, (name) => name.endsWith(".md"))
  }
  result.themePaths = walkFiles(join(root, "themes"), root, config.exclude, (name) => name.endsWith(".json"))
  if (config.skills) {
    result.skillPaths = walkSkillDirs(join(root, "skills"), root, config.exclude)
  }
  return result
}
