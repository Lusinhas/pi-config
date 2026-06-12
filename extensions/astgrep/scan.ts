import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Lang, parseAsync } from "@ast-grep/napi"
import type { SgNode, SgRoot } from "@ast-grep/napi"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

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

export interface TargetFile {
  abs: string
  rel: string
  lang: string
}

export interface Collected {
  files: TargetFile[]
  missing: string[]
  skippedNoLang: number
  skippedLarge: number
  capped: boolean
}

export interface FileMatch {
  file: TargetFile
  content: string
  root: SgRoot
  matches: SgNode[]
}

export interface ScanResult {
  results: FileMatch[]
  scanned: number
  total: number
  truncated: boolean
  unscanned: number
  parseErrors: string[]
  parseErrorCount: number
  unsupported: Map<string, number>
  patternErrors: Map<string, string>
}

export type GlobTest = (rel: string, abs: string, base: string) => boolean

export function toRel(cwd: string, abs: string): string {
  const rel = relative(cwd, abs)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return abs.split(sep).join("/")
  return rel.split(sep).join("/")
}

export function langChoices(map: Record<string, string>): string[] {
  return [...new Set(Object.values(map))].sort()
}

export function inferLang(path: string, map: Record<string, string>): string | undefined {
  const ext = extname(path).toLowerCase().replace(/^\./, "")
  if (!ext) return undefined
  return map[ext]
}

export function supportedLangs(): Set<string> {
  try {
    const source = Lang as unknown as Record<string, unknown>
    const names = [...Object.getOwnPropertyNames(source), ...Object.keys(source)]
    const values = new Set<string>()
    for (const name of names) {
      const value = source[name]
      if (typeof value === "string") values.add(value)
    }
    return values
  } catch {
    return new Set()
  }
}

async function gitFiles(pi: ExtensionAPI, dir: string, timeout: number): Promise<string[] | undefined> {
  try {
    const probe = await pi.exec("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { timeout })
    if (probe.code !== 0 || probe.stdout.trim() !== "true") return undefined
    const listed = await pi.exec(
      "git",
      ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { timeout }
    )
    if (listed.code !== 0) return undefined
    return listed.stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => join(dir, entry))
  } catch {
    return undefined
  }
}

function walk(dir: string, out: string[], cap: number): void {
  if (out.length >= cap) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= cap) return
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      walk(join(dir, entry.name), out, cap)
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name))
    }
  }
}

export async function collectFiles(
  pi: ExtensionAPI,
  cwd: string,
  paths: string[] | undefined,
  config: AstConfig,
  explicitLang: string | undefined
): Promise<Collected> {
  const roots = paths && paths.length > 0 ? paths : ["."]
  const seen = new Set<string>()
  const files: TargetFile[] = []
  const missing: string[] = []
  let skippedNoLang = 0
  let skippedLarge = 0
  let capped = false
  const walkCap = Math.max(config.fileLimit * 10, 20000)

  const push = (abs: string, forced: boolean): void => {
    if (files.length >= config.fileLimit) {
      capped = true
      return
    }
    if (seen.has(abs)) return
    let info
    try {
      info = statSync(abs)
    } catch {
      return
    }
    if (!info.isFile()) return
    seen.add(abs)
    const inferred = inferLang(abs, config.langMap)
    const lang = explicitLang ?? inferred
    if (!lang) {
      skippedNoLang += 1
      return
    }
    if (explicitLang && !forced && inferred !== explicitLang) return
    if (info.size > config.maxFileBytes) {
      skippedLarge += 1
      return
    }
    files.push({ abs, rel: toRel(cwd, abs), lang })
  }

  for (const root of roots) {
    if (typeof root !== "string" || root.trim() === "") continue
    const abs = resolve(cwd, root)
    let info
    try {
      info = statSync(abs)
    } catch {
      missing.push(root)
      continue
    }
    if (info.isFile()) {
      push(abs, true)
      continue
    }
    if (!info.isDirectory()) {
      missing.push(root)
      continue
    }
    const fromGit = await gitFiles(pi, abs, config.execTimeout)
    let candidates: string[]
    if (fromGit) {
      candidates = fromGit
    } else {
      candidates = []
      walk(abs, candidates, walkCap)
    }
    for (const candidate of candidates) {
      if (files.length >= config.fileLimit) {
        capped = true
        break
      }
      push(candidate, false)
    }
  }

  return { files, missing, skippedNoLang, skippedLarge, capped }
}

const PARSE_ERROR_SAMPLES = 10

export async function scanMatches(
  files: TargetFile[],
  pattern: string,
  maxMatches: number,
  signal: AbortSignal | undefined
): Promise<ScanResult> {
  const supported = supportedLangs()
  const unsupported = new Map<string, number>()
  const patternErrors = new Map<string, string>()
  const parseErrors: string[] = []
  const results: FileMatch[] = []
  let parseErrorCount = 0
  let scanned = 0
  let total = 0
  let truncated = false
  let unscanned = 0

  for (let index = 0; index < files.length; index += 1) {
    if (signal?.aborted) throw new Error("ast-grep scan aborted")
    if (total >= maxMatches) {
      truncated = true
      unscanned = files.length - index
      break
    }
    const file = files[index]
    if (supported.size > 0 && !supported.has(file.lang)) {
      unsupported.set(file.lang, (unsupported.get(file.lang) ?? 0) + 1)
      continue
    }
    if (patternErrors.has(file.lang)) continue
    let content: string
    try {
      content = readFileSync(file.abs, "utf8")
    } catch {
      parseErrorCount += 1
      if (parseErrors.length < PARSE_ERROR_SAMPLES) parseErrors.push(file.rel)
      continue
    }
    if (content.includes("\0")) continue
    let root: SgRoot
    try {
      root = await parseAsync(file.lang, content)
    } catch {
      parseErrorCount += 1
      if (parseErrors.length < PARSE_ERROR_SAMPLES) parseErrors.push(file.rel)
      continue
    }
    scanned += 1
    let matches: SgNode[]
    try {
      matches = root.root().findAll(pattern) as SgNode[]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      patternErrors.set(file.lang, message)
      continue
    }
    if (matches.length === 0) continue
    total += matches.length
    results.push({ file, content, root, matches })
  }

  if (total > maxMatches) truncated = true
  return {
    results,
    scanned,
    total,
    truncated,
    unscanned,
    parseErrors,
    parseErrorCount,
    unsupported,
    patternErrors
  }
}

export function globToRegExp(glob: string): RegExp {
  let pattern = "^"
  let index = 0
  while (index < glob.length) {
    const char = glob[index]
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          pattern += "(?:[^/]*/)*"
          index += 3
        } else {
          pattern += ".*"
          index += 2
        }
      } else {
        pattern += "[^/]*"
        index += 1
      }
    } else if (char === "?") {
      pattern += "[^/]"
      index += 1
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
      index += 1
    }
  }
  return new RegExp(`${pattern}$`)
}

export function compileGlobs(globs: string[]): GlobTest[] {
  const matchers: GlobTest[] = []
  for (const glob of globs) {
    if (typeof glob !== "string" || glob.trim() === "") continue
    let regex: RegExp
    try {
      regex = globToRegExp(glob.trim())
    } catch {
      continue
    }
    const bare = !glob.includes("/")
    matchers.push((rel, abs, base) => regex.test(rel) || regex.test(abs) || (bare && regex.test(base)))
  }
  return matchers
}

export function isProtected(file: TargetFile, matchers: GlobTest[]): boolean {
  const abs = file.abs.split(sep).join("/")
  const base = abs.slice(abs.lastIndexOf("/") + 1)
  return matchers.some((test) => test(file.rel, abs, base))
}
