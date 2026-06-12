import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

export interface WorktreeConfig {
  dir: string
  branchPrefix: string
  includeFile: string
  defaultRef: string
  allowSpawn: boolean
  spawnCommand: string
  confirmRemove: boolean
  maxIncludeFiles: number
  gitTimeoutMs: number
}

export interface WorktreeEntry {
  path: string
  head: string
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockedReason: string
  prunable: boolean
  prunableReason: string
  isMain: boolean
}

export interface RepoInfo {
  currentRoot: string
  mainRoot: string
  commonDir: string
  entries: WorktreeEntry[]
}

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

export interface CopyOutcome {
  copied: number
  failed: number
  truncated: boolean
}

export interface CreateOutcome {
  name: string
  path: string
  branch: string
  ref: string
  created: boolean
  copied: number
  copyFailed: number
  copyTruncated: boolean
  notes: string[]
}

export interface RemoveOutcome {
  removed: boolean
  message: string
}

interface CompiledPattern {
  regex: RegExp
  dirOnly: boolean
  negated: boolean
  anchored: boolean
  literalHead: string
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export async function git(pi: ExtensionAPI, cwd: string, args: string[], timeoutMs: number): Promise<GitResult> {
  try {
    const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: timeoutMs })
    const code = typeof result.code === "number" ? result.code : -1
    return { ok: code === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", code }
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1 }
  }
}

function toPosix(path: string): string {
  return path.split(sep).join("/")
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export function worktreeBase(config: WorktreeConfig, mainRoot: string): string {
  if (isAbsolute(config.dir)) return join(config.dir, basename(mainRoot))
  return resolve(mainRoot, config.dir)
}

export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name) || name.includes("..")) {
    throw new Error(
      `Invalid worktree name "${name}": use letters, digits, dots, dashes, and underscores, starting with a letter or digit`
    )
  }
}

export async function listWorktrees(pi: ExtensionAPI, cwd: string, config: WorktreeConfig): Promise<WorktreeEntry[]> {
  const result = await git(pi, cwd, ["worktree", "list", "--porcelain"], config.gitTimeoutMs)
  if (!result.ok) {
    throw new Error(`git worktree list failed: ${(result.stderr || result.stdout).trim() || "unknown error"}`)
  }
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) {
      if (current) entries.push(current)
      current = null
      continue
    }
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current)
      current = {
        path: line.slice("worktree ".length),
        head: "",
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        lockedReason: "",
        prunable: false,
        prunableReason: "",
        isMain: false
      }
      continue
    }
    if (!current) continue
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length)
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
    else if (line === "detached") current.detached = true
    else if (line === "bare") current.bare = true
    else if (line === "locked") current.locked = true
    else if (line.startsWith("locked ")) {
      current.locked = true
      current.lockedReason = line.slice("locked ".length)
    } else if (line === "prunable") current.prunable = true
    else if (line.startsWith("prunable ")) {
      current.prunable = true
      current.prunableReason = line.slice("prunable ".length)
    }
  }
  if (current) entries.push(current)
  if (entries.length > 0) entries[0].isMain = true
  return entries
}

export async function detectRepo(pi: ExtensionAPI, cwd: string, config: WorktreeConfig): Promise<RepoInfo> {
  const inside = await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], config.gitTimeoutMs)
  if (!inside.ok || inside.stdout.trim() !== "true") {
    throw new Error(`Not a git repository: ${cwd}. Worktree operations only work inside a git checkout.`)
  }
  const top = await git(pi, cwd, ["rev-parse", "--show-toplevel"], config.gitTimeoutMs)
  if (!top.ok || !top.stdout.trim()) {
    throw new Error(`Could not resolve the repository root: ${top.stderr.trim() || "git rev-parse failed"}`)
  }
  const currentRoot = top.stdout.trim()
  let commonDir = ""
  const absolute = await git(pi, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], config.gitTimeoutMs)
  if (absolute.ok && absolute.stdout.trim()) {
    commonDir = absolute.stdout.trim()
  } else {
    const fallback = await git(pi, cwd, ["rev-parse", "--git-common-dir"], config.gitTimeoutMs)
    if (!fallback.ok || !fallback.stdout.trim()) {
      throw new Error(`Could not resolve the git common dir: ${fallback.stderr.trim() || "git rev-parse failed"}`)
    }
    commonDir = resolve(cwd, fallback.stdout.trim())
  }
  const entries = await listWorktrees(pi, cwd, config)
  const mainRoot = entries.length > 0 ? entries[0].path : currentRoot
  return { currentRoot, mainRoot, commonDir, entries }
}

export function findEntry(entries: WorktreeEntry[], base: string, name: string): WorktreeEntry | undefined {
  const target = resolve(base, name)
  const exact = entries.find(entry => resolve(entry.path) === target)
  if (exact) return exact
  const named = entries.filter(entry => !entry.isMain && basename(entry.path) === name)
  if (named.length <= 1) return named[0]
  const managed = named.filter(entry => isInside(entry.path, base))
  if (managed.length === 1) return managed[0]
  throw new Error(
    `Multiple worktrees are named "${name}": ${named.map(entry => entry.path).join(", ")}. Remove the extras with git worktree remove <path>.`
  )
}

function ensureExcluded(repo: RepoInfo, base: string): void {
  const rel = relative(repo.mainRoot, base)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return
  const line = `/${toPosix(rel)}/`
  try {
    const infoDir = join(repo.commonDir, "info")
    const excludePath = join(infoDir, "exclude")
    mkdirSync(infoDir, { recursive: true })
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : ""
    if (current.split(/\r?\n/).includes(line)) return
    const separator = current && !current.endsWith("\n") ? "\n" : ""
    appendFileSync(excludePath, `${separator}${line}\n`)
  } catch {}
}

function globToSource(pattern: string): string {
  let src = ""
  let i = 0
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      src += "(?:[^/]+/)*"
      i += 3
      continue
    }
    if (pattern.startsWith("**", i)) {
      src += ".*"
      i += 2
      continue
    }
    const ch = pattern[i]
    if (ch === "*") src += "[^/]*"
    else if (ch === "?") src += "[^/]"
    else if ("\\^$.|+()[]{}".includes(ch)) src += `\\${ch}`
    else src += ch
    i++
  }
  return src
}

function compilePatterns(raw: string): CompiledPattern[] {
  const patterns: CompiledPattern[] = []
  for (const line of raw.split(/\r?\n/)) {
    let text = line.trim()
    if (!text || text.startsWith("#")) continue
    let negated = false
    if (text.startsWith("!")) {
      negated = true
      text = text.slice(1).trim()
    }
    let dirOnly = false
    if (text.endsWith("/")) {
      dirOnly = true
      text = text.slice(0, -1)
    }
    let anchored = false
    if (text.startsWith("/")) {
      anchored = true
      text = text.slice(1)
    }
    if (!text) continue
    if (text.includes("/")) anchored = true
    const literalHead = anchored ? text.split(/[*?]/, 1)[0] : ""
    const prefix = anchored ? "^" : "^(?:.*/)?"
    try {
      patterns.push({
        regex: new RegExp(`${prefix}${globToSource(text)}$`),
        dirOnly,
        negated,
        anchored,
        literalHead
      })
    } catch {}
  }
  return patterns
}

function matchesOne(pattern: CompiledPattern, rel: string, isDir: boolean): boolean {
  if (pattern.regex.test(rel)) return isDir || !pattern.dirOnly
  const segments = rel.split("/")
  let prefix = ""
  for (let i = 0; i < segments.length - 1; i++) {
    prefix = prefix ? `${prefix}/${segments[i]}` : segments[i]
    if (pattern.regex.test(prefix)) return true
  }
  return false
}

function decide(patterns: CompiledPattern[], rel: string, isDir: boolean): boolean {
  let included = false
  for (const pattern of patterns) {
    if (matchesOne(pattern, rel, isDir)) included = !pattern.negated
  }
  return included
}

function shouldDescend(patterns: CompiledPattern[], dirRel: string): boolean {
  for (const pattern of patterns) {
    if (pattern.negated || !pattern.anchored) continue
    if (pattern.literalHead.startsWith(`${dirRel}/`)) return true
  }
  return false
}

function walkFiles(absDir: string, relDir: string, out: string[], cap: number): void {
  if (out.length >= cap) return
  let items
  try {
    items = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    if (out.length >= cap) return
    if (item.name === ".git") continue
    const abs = join(absDir, item.name)
    const rel = relDir ? `${relDir}/${item.name}` : item.name
    if (item.isDirectory()) walkFiles(abs, rel, out, cap)
    else out.push(rel)
  }
}

export async function copyIncludes(
  pi: ExtensionAPI,
  config: WorktreeConfig,
  mainRoot: string,
  base: string,
  target: string
): Promise<CopyOutcome> {
  const outcome: CopyOutcome = { copied: 0, failed: 0, truncated: false }
  const includePath = join(mainRoot, config.includeFile)
  let raw = ""
  try {
    if (!existsSync(includePath) || !lstatSync(includePath).isFile()) return outcome
    raw = readFileSync(includePath, "utf8")
  } catch {
    return outcome
  }
  const patterns = compilePatterns(raw)
  if (patterns.length === 0) return outcome
  const cap = config.maxIncludeFiles
  const baseRel = isInside(base, mainRoot) ? toPosix(relative(mainRoot, base)) : ""
  const untracked = await git(pi, mainRoot, ["ls-files", "--others", "--exclude-standard", "-z"], config.gitTimeoutMs)
  const ignored = await git(
    pi,
    mainRoot,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    config.gitTimeoutMs
  )
  const candidates = new Set<string>()
  for (const chunk of `${untracked.stdout}\0${ignored.stdout}`.split("\0")) {
    if (chunk) candidates.add(chunk)
  }
  const selected = new Set<string>()
  for (const candidate of candidates) {
    if (selected.size > cap) break
    const isDir = candidate.endsWith("/")
    const rel = isDir ? candidate.slice(0, -1) : candidate
    if (!rel || rel === config.includeFile) continue
    if (baseRel && (rel === baseRel || rel.startsWith(`${baseRel}/`))) continue
    if (decide(patterns, rel, isDir)) {
      if (isDir) {
        const files: string[] = []
        walkFiles(join(mainRoot, ...rel.split("/")), rel, files, cap + 1)
        for (const file of files) selected.add(file)
      } else {
        selected.add(rel)
      }
    } else if (isDir && shouldDescend(patterns, rel)) {
      const files: string[] = []
      walkFiles(join(mainRoot, ...rel.split("/")), rel, files, cap + 1)
      for (const file of files) {
        if (decide(patterns, file, false)) selected.add(file)
      }
    }
  }
  const files = [...selected]
  if (files.length > cap) {
    outcome.truncated = true
    files.length = cap
  }
  for (const rel of files) {
    const parts = rel.split("/")
    const src = join(mainRoot, ...parts)
    const dest = join(target, ...parts)
    try {
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest, { force: true, verbatimSymlinks: true })
      outcome.copied++
    } catch {
      outcome.failed++
    }
  }
  return outcome
}

export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  config: WorktreeConfig,
  name: string,
  ref: string | undefined
): Promise<CreateOutcome> {
  validateName(name)
  const repo = await detectRepo(pi, cwd, config)
  const base = worktreeBase(config, repo.mainRoot)
  const existing = findEntry(repo.entries, base, name)
  if (existing) {
    if (existing.isMain) {
      throw new Error(`"${name}" resolves to the main worktree at ${existing.path}; refusing to touch it`)
    }
    return {
      name,
      path: existing.path,
      branch: existing.branch ?? `(detached ${existing.head.slice(0, 9)})`,
      ref: existing.head.slice(0, 9),
      created: false,
      copied: 0,
      copyFailed: 0,
      copyTruncated: false,
      notes: []
    }
  }
  const target = join(base, name)
  if (existsSync(target)) {
    throw new Error(`Path ${target} exists but is not a registered worktree; remove it or pick another name`)
  }
  const branch = `${config.branchPrefix}${name}`
  const holder = repo.entries.find(entry => entry.branch === branch)
  if (holder) {
    throw new Error(`Branch ${branch} is already checked out at ${holder.path}`)
  }
  const baseRef = (ref ?? "").trim() || config.defaultRef
  const branchExists = (
    await git(pi, cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], config.gitTimeoutMs)
  ).ok
  mkdirSync(base, { recursive: true })
  ensureExcluded(repo, base)
  const notes: string[] = []
  let added: GitResult
  if (branchExists) {
    notes.push(`Reused existing branch ${branch}; the [ref] argument was ignored.`)
    added = await git(pi, cwd, ["worktree", "add", target, branch], config.gitTimeoutMs)
  } else {
    const verified = await git(pi, cwd, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], config.gitTimeoutMs)
    if (!verified.ok) {
      throw new Error(`Unknown ref "${baseRef}"; it must resolve to a commit (a repository with no commits cannot host worktrees)`)
    }
    added = await git(pi, cwd, ["worktree", "add", "-b", branch, target, baseRef], config.gitTimeoutMs)
  }
  if (!added.ok) {
    throw new Error(`git worktree add failed: ${(added.stderr || added.stdout).trim() || "unknown error"}`)
  }
  const copy = await copyIncludes(pi, config, repo.mainRoot, base, target)
  if (copy.truncated) notes.push(`Include copy truncated at ${config.maxIncludeFiles} files.`)
  return {
    name,
    path: target,
    branch,
    ref: baseRef,
    created: true,
    copied: copy.copied,
    copyFailed: copy.failed,
    copyTruncated: copy.truncated,
    notes
  }
}

export async function removeWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: WorktreeConfig,
  name: string
): Promise<RemoveOutcome> {
  const repo = await detectRepo(pi, ctx.cwd, config)
  const base = worktreeBase(config, repo.mainRoot)
  const entry = findEntry(repo.entries, base, name)
  if (!entry) {
    const known = repo.entries.filter(item => !item.isMain).map(item => basename(item.path))
    const hint = known.length > 0 ? ` Known worktrees: ${known.join(", ")}.` : " No linked worktrees exist."
    throw new Error(`No worktree named "${name}".${hint}`)
  }
  if (entry.isMain) {
    throw new Error(`"${name}" is the main worktree at ${entry.path}; refusing to touch it`)
  }
  if (isInside(ctx.cwd, entry.path)) {
    throw new Error(`Cannot remove ${entry.path}: the current session is running inside it`)
  }
  if (!existsSync(entry.path)) {
    const pruned = await git(pi, ctx.cwd, ["worktree", "prune"], config.gitTimeoutMs)
    if (!pruned.ok) {
      throw new Error(`Worktree directory is already gone and prune failed: ${(pruned.stderr || pruned.stdout).trim()}`)
    }
    return { removed: true, message: `Worktree "${name}" directory was already gone; pruned its stale registration.` }
  }
  const status = await git(pi, entry.path, ["status", "--porcelain"], config.gitTimeoutMs)
  if (!status.ok) {
    throw new Error(`Could not check worktree status: ${(status.stderr || status.stdout).trim() || "git status failed"}`)
  }
  const dirty = status.stdout.trim().length > 0
  let force = false
  if (dirty) {
    if (!ctx.hasUI) {
      throw new Error(
        `Worktree "${name}" has uncommitted changes; refusing to remove it without a UI. Commit or stash the changes, or remove it interactively.`
      )
    }
    const confirmed = await ctx.ui.confirm(
      "Remove dirty worktree",
      `"${name}" at ${entry.path} has uncommitted changes. Force remove and discard them?`
    )
    if (!confirmed) return { removed: false, message: `Kept worktree "${name}" at ${entry.path}.` }
    force = true
  } else if (config.confirmRemove && ctx.hasUI) {
    const confirmed = await ctx.ui.confirm("Remove worktree", `Remove "${name}" at ${entry.path}?`)
    if (!confirmed) return { removed: false, message: `Kept worktree "${name}" at ${entry.path}.` }
  }
  const args = force ? ["worktree", "remove", "--force", entry.path] : ["worktree", "remove", entry.path]
  const removed = await git(pi, ctx.cwd, args, config.gitTimeoutMs)
  if (!removed.ok) {
    throw new Error(`git worktree remove failed: ${(removed.stderr || removed.stdout).trim() || "unknown error"}`)
  }
  let branchNote = ""
  if (entry.branch && config.branchPrefix && entry.branch.startsWith(config.branchPrefix)) {
    const deleted = await git(pi, ctx.cwd, ["branch", "-d", entry.branch], config.gitTimeoutMs)
    branchNote = deleted.ok
      ? ` Branch ${entry.branch} deleted.`
      : ` Branch ${entry.branch} kept (not fully merged; delete it with git branch -D ${entry.branch}).`
  }
  return { removed: true, message: `Removed worktree "${name}" at ${entry.path}.${branchNote}` }
}

export async function pruneWorktrees(pi: ExtensionAPI, cwd: string, config: WorktreeConfig): Promise<string> {
  const inside = await git(pi, cwd, ["rev-parse", "--is-inside-work-tree"], config.gitTimeoutMs)
  if (!inside.ok || inside.stdout.trim() !== "true") {
    throw new Error(`Not a git repository: ${cwd}. Worktree operations only work inside a git checkout.`)
  }
  const result = await git(pi, cwd, ["worktree", "prune", "--verbose"], config.gitTimeoutMs)
  if (!result.ok) {
    throw new Error(`git worktree prune failed: ${(result.stderr || result.stdout).trim() || "unknown error"}`)
  }
  const output = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
  if (output.length === 0) return "Nothing to prune; every registered worktree is intact."
  return `Pruned stale worktree records:\n${output.map(line => `  ${line}`).join("\n")}`
}
