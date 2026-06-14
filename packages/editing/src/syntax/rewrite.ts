import { createHash, randomBytes } from "node:crypto"
import type { AstConfig } from "./settings.ts"
import type { Collected, FileDiscovery, TargetFile } from "./discovery.ts"
import { ProtectFilter } from "./glob.ts"
import type { FileMatch, MatchEdit, MatchNode, ScanResult } from "./scan.ts"
import { DiffEngine } from "./diff.ts"
import { Phrase } from "./format.ts"
import type { ToolOutput } from "./format.ts"

const TOKEN = /\$\$\$[A-Z_][A-Z0-9_]*|\$[A-Z_][A-Z0-9_]*/g
const DIFF_CONTEXT = 3
const CLIP = 200
const MAX_STAGE_BYTES = 67108864

export interface Planned {
  abs: string
  rel: string
  hash: string
  content: string
  after: string
  matchCount: number
}

export interface PlanResult {
  planned: Planned[]
  replaced: number
  overlapped: number
  failures: string[]
}

export interface StagedFile {
  abs: string
  rel: string
  hash: string
  after: string
  matchCount: number
}

export interface StagedSet {
  id: string
  createdAt: number
  pattern: string
  rewrite: string
  totalMatches: number
  files: StagedFile[]
}

export interface WriteOutcome {
  written: string[]
  raced: string[]
  failed: string[]
}

export interface RewriteRequest {
  pattern?: string
  rewrite?: string
  lang?: string
  paths?: string[]
  apply?: boolean
  applyId?: string
}

export type Scanner = (
  files: TargetFile[],
  pattern: string,
  maxMatches: number,
  signal: AbortSignal | undefined
) => Promise<ScanResult>

export type Writer = (files: Array<StagedFile | Planned>) => Promise<WriteOutcome>

export type Reader = (abs: string) => string

export class Hashing {
  static sha(text: string): string {
    return createHash("sha256").update(text).digest("hex")
  }
}

export class Substitution {
  private readonly pattern: string

  constructor(pattern: string) {
    this.pattern = pattern
  }

  apply(template: string, match: MatchNode, source: string): string {
    return template.replace(TOKEN, (token) => this.replaceToken(token, match, source))
  }

  private replaceToken(token: string, match: MatchNode, source: string): string {
    const multi = token.startsWith("$$$")
    const name = multi ? token.slice(3) : token.slice(1)

    if (!this.pattern.includes(multi ? `$$$${name}` : `$${name}`)) {
      return token
    }

    try {
      if (multi) {
        const nodes = match.getMultipleMatches(name)

        if (!Array.isArray(nodes) || nodes.length === 0) {
          return ""
        }

        const start = nodes[0].range().start.index
        const end = nodes[nodes.length - 1].range().end.index

        return source.slice(start, end)
      }

      const captured = match.getMatch(name)

      return captured ? captured.text() : token
    } catch {
      return token
    }
  }
}

export class EditPlanner {
  private readonly substitution: Substitution
  private readonly template: string

  constructor(pattern: string, template: string) {
    this.substitution = new Substitution(pattern)
    this.template = template
  }

  plan(results: FileMatch[]): PlanResult {
    const planned: Planned[] = []
    const failures: string[] = []
    let replaced = 0
    let overlapped = 0

    for (const result of results) {
      let edits: MatchEdit[]

      try {
        edits = result.matches.map((match) => match.replace(this.substitution.apply(this.template, match, result.content)))
      } catch (error) {
        failures.push(`${result.file.rel}: ${EditPlanner.message(error)}`)
        continue
      }

      const kept = this.keepNonOverlapping(edits)
      overlapped += edits.length - kept.length
      let after: string

      try {
        after = this.commit(result, kept)
      } catch (error) {
        failures.push(`${result.file.rel}: ${EditPlanner.message(error)}`)
        continue
      }

      if (after === result.content) {
        continue
      }

      replaced += kept.length
      planned.push({
        abs: result.file.abs,
        rel: result.file.rel,
        hash: Hashing.sha(result.content),
        content: result.content,
        after,
        matchCount: kept.length
      })
    }

    return { planned, replaced, overlapped, failures }
  }

  private keepNonOverlapping(edits: MatchEdit[]): MatchEdit[] {
    const sorted = [...edits].sort((left, right) => left.startPos - right.startPos)
    const kept: MatchEdit[] = []
    let lastEnd = -1

    for (const edit of sorted) {
      if (edit.startPos >= lastEnd) {
        kept.push(edit)
        lastEnd = edit.endPos
      }
    }

    return kept
  }

  private commit(result: FileMatch, kept: MatchEdit[]): string {
    const rootNode = result.root.root()
    const span = rootNode.range()
    const head = result.content.slice(0, span.start.index)
    const tail = result.content.slice(span.end.index)

    return head + rootNode.commitEdits(kept) + tail
  }

  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

export class StagedStore {
  private readonly sets = new Map<string, StagedSet>()
  private readonly maxStaged: number

  constructor(maxStaged: number) {
    this.maxStaged = maxStaged
  }

  has(id: string): boolean {
    return this.sets.has(id)
  }

  get(id: string): StagedSet | undefined {
    return this.sets.get(id)
  }

  delete(id: string): void {
    this.sets.delete(id)
  }

  ids(): string[] {
    return [...this.sets.keys()]
  }

  makeId(): string {
    let id = randomBytes(3).toString("hex")

    while (this.sets.has(id)) {
      id = randomBytes(3).toString("hex")
    }

    return id
  }

  stage(set: StagedSet): void {
    this.sets.set(set.id, set)

    while (this.sets.size > this.maxStaged) {
      const oldest = this.sets.keys().next().value

      if (oldest === undefined) {
        break
      }

      this.sets.delete(oldest)
    }
  }

  guardBytes(planned: Planned[]): void {
    const stageBytes = planned.reduce((sum, file) => sum + file.after.length + file.content.length, 0)

    if (stageBytes > MAX_STAGE_BYTES) {
      throw new Error(
        `astrewrite: staging would hold ${stageBytes} bytes in memory (limit ${MAX_STAGE_BYTES}). Narrow paths, or pass apply: true to write directly.`
      )
    }
  }

  build(id: string, pattern: string, rewrite: string, replaced: number, planned: Planned[]): StagedSet {
    return {
      id,
      createdAt: Date.now(),
      pattern,
      rewrite,
      totalMatches: replaced,
      files: planned.map((file) => ({
        abs: file.abs,
        rel: file.rel,
        hash: file.hash,
        after: file.after,
        matchCount: file.matchCount
      }))
    }
  }
}

export class CommitGuard {
  private readonly store: StagedStore
  private readonly maxStaged: number

  constructor(store: StagedStore, maxStaged: number) {
    this.store = store
    this.maxStaged = maxStaged
  }

  require(id: string): StagedSet {
    const set = this.store.get(id)

    if (set) {
      return set
    }

    const known = this.store.ids()

    throw new Error(
      `astrewrite: no staged rewrite with id "${id}"${known.length > 0 ? ` (staged: ${known.join(", ")})` : ""}. Staged sets live in memory and expire on restart or after ${this.maxStaged} newer stages; re-run astrewrite with pattern and rewrite to stage again.`
    )
  }

  checkStale(id: string, set: StagedSet, read: (abs: string) => string): void {
    const stale: string[] = []

    for (const file of set.files) {
      try {
        if (Hashing.sha(read(file.abs)) !== file.hash) {
          stale.push(file.rel)
        }
      } catch {
        stale.push(file.rel)
      }
    }

    if (stale.length > 0) {
      this.store.delete(id)

      throw new Error(
        `astrewrite: staged set ${id} is stale; these files changed on disk since staging: ${stale.join(", ")}. Nothing was written. Re-run astrewrite with the pattern and rewrite to re-stage against current contents.`
      )
    }
  }

  partialFailure(id: string, set: StagedSet, outcome: WriteOutcome): Error | undefined {
    if (outcome.raced.length === 0 && outcome.failed.length === 0) {
      return undefined
    }

    const problems = CommitGuard.problems(outcome)

    return new Error(
      `astrewrite: applied ${outcome.written.length} of ${set.files.length} files from ${id}; ${problems}. Re-stage with astrewrite to fix the remaining files.`
    )
  }

  static applyFailure(planned: Planned[], outcome: WriteOutcome): Error | undefined {
    if (outcome.raced.length === 0 && outcome.failed.length === 0) {
      return undefined
    }

    const problems = CommitGuard.problems(outcome)

    return new Error(
      `astrewrite: wrote ${outcome.written.length} of ${planned.length} files; ${problems}. Re-run astrewrite for the remaining files.`
    )
  }

  private static problems(outcome: WriteOutcome): string {
    return [
      outcome.raced.length > 0 ? `changed during apply: ${outcome.raced.join(", ")}` : "",
      outcome.failed.length > 0 ? `write failed: ${outcome.failed.join("; ")}` : ""
    ]
      .filter((part) => part !== "")
      .join("; ")
  }
}

export class RewriteFormatter {
  private readonly config: AstConfig
  private readonly choices: string[]

  constructor(config: AstConfig, choices: string[]) {
    this.config = config
    this.choices = choices
  }

  nothingToRewrite(pattern: string, blocked: string[], skippedNoLang: number): ToolOutput {
    const detail =
      blocked.length > 0
        ? `all ${blocked.length} candidate files are protected by protectGlobs config (e.g. ${blocked.slice(0, 5).join(", ")})`
        : `no files with a mapped language found (${skippedNoLang} files had no mapped extension)`

    return {
      content: [{ type: "text", text: `Nothing to rewrite: ${detail}.` }],
      details: { pattern, total: 0, protectedFiles: blocked.length }
    }
  }

  noMatch(pattern: string, collected: Collected, scanned: number): ToolOutput {
    const langs = [...new Set(collected.files.map((file) => file.lang))].sort()
    const lines = [
      `No matches for pattern "${pattern}"; nothing to rewrite.`,
      `Searched ${scanned} files (inferred languages: ${langs.join(", ") || "none"}).`,
      `If the inferred language is wrong, pass lang explicitly (choices: ${this.choices.join(", ")}).`
    ]

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { pattern, total: 0, scanned, languages: langs }
    }
  }

  matchedNoChange(pattern: string, total: number, fileCount: number, failures: string[]): ToolOutput {
    const reason =
      failures.length > 0
        ? `edit computation failed: ${failures.slice(0, 3).join("; ")}`
        : "the rewrite output is identical to the source"

    return {
      content: [
        {
          type: "text",
          text: `Pattern "${pattern}" matched ${Phrase.plural(total, "time")} in ${Phrase.plural(fileCount, "file")} but produced no changes (${reason}).`
        }
      ],
      details: { pattern, total, changedFiles: 0 }
    }
  }

  notes(blocked: string[], overlapped: number, failures: string[], capped: boolean): string[] {
    const notes: string[] = []

    if (blocked.length > 0) {
      notes.push(
        `Skipped ${Phrase.plural(blocked.length, "protected file")} (protectGlobs config), e.g. ${blocked.slice(0, 5).join(", ")}.`
      )
    }

    if (overlapped > 0) {
      notes.push(`Dropped ${Phrase.plural(overlapped, "overlapping nested match", "overlapping nested matches")}; re-run after applying to catch them.`)
    }

    if (failures.length > 0) {
      notes.push(`Edit computation failed for ${Phrase.plural(failures.length, "file")}: ${failures.slice(0, 3).join("; ")}.`)
    }

    if (capped) {
      notes.push(`File scan capped at ${this.config.fileLimit} files (fileLimit config).`)
    }

    return notes
  }

  applied(pattern: string, template: string, replaced: number, planned: Planned[], written: string[], notes: string[]): ToolOutput {
    const lines = [`Rewrote ${Phrase.plural(replaced, "match", "matches")} in ${Phrase.plural(written.length, "file")}.`]

    for (const file of planned) {
      lines.push(`  ${file.rel} (${Phrase.plural(file.matchCount, "replacement")})`)
    }

    if (notes.length > 0) {
      lines.push("")

      for (const note of notes) {
        lines.push(`Note: ${note}`)
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { pattern, rewrite: template, files: written, replaced }
    }
  }

  staged(id: string, pattern: string, template: string, replaced: number, planned: Planned[], notes: string[]): ToolOutput {
    const lines = [
      `Staged rewrite ${id}: ${Phrase.plural(replaced, "replacement")} across ${Phrase.plural(planned.length, "file")}. Nothing has been written yet.`,
      ""
    ]
    let budget = this.config.maxHunks
    let omittedHunks = 0
    const omittedFiles: string[] = []

    for (const file of planned) {
      const rendered = DiffEngine.render(file.rel, file.content, file.after, DIFF_CONTEXT, budget)

      if (rendered.shown > 0) {
        lines.push(rendered.text)
        lines.push("")
      } else if (rendered.total > 0) {
        omittedFiles.push(file.rel)
      }

      budget -= rendered.shown
      omittedHunks += rendered.total - rendered.shown
    }

    if (omittedHunks > 0) {
      lines.push(
        `Preview truncated at ${this.config.maxHunks} hunks; ${omittedHunks} more hunks${omittedFiles.length > 0 ? ` (files without preview: ${omittedFiles.join(", ")})` : ""} not shown.`
      )
    }

    lines.push(
      `To write these changes call astrewrite with {"applyId": "${id}"}. Files are hash-checked at apply time; if any change on disk first, the apply fails and you must re-stage.`
    )

    for (const note of notes) {
      lines.push(`Note: ${note}`)
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        applyId: id,
        pattern,
        rewrite: template,
        replaced,
        files: planned.map((file) => ({ path: file.rel, matches: file.matchCount }))
      }
    }
  }

  commitSuccess(id: string, set: StagedSet, written: string[]): ToolOutput {
    const lines = [
      `Applied rewrite ${id}: ${Phrase.plural(set.totalMatches, "replacement")} written to ${Phrase.plural(written.length, "file")}.`
    ]

    for (const file of set.files) {
      lines.push(`  ${file.rel} (${Phrase.plural(file.matchCount, "replacement")})`)
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { applyId: id, files: written, replaced: set.totalMatches }
    }
  }

  patternError(prefix: string, pattern: string, lang: string, message: string): Error {
    return new Error(
      `${prefix}: pattern "${pattern}" failed against ${lang}: ${Phrase.clip(message, CLIP)}. Patterns must be complete, parsable ${lang} code.`
    )
  }
}

export class RewriteRunner {
  private readonly config: AstConfig
  private readonly choices: string[]
  private readonly available: string[]
  private readonly discovery: FileDiscovery
  private readonly store: StagedStore
  private readonly commitGuard: CommitGuard
  private readonly scanner: Scanner
  private readonly writer: Writer
  private readonly reader: Reader

  constructor(
    config: AstConfig,
    choices: string[],
    available: string[],
    discovery: FileDiscovery,
    store: StagedStore,
    commitGuard: CommitGuard,
    scanner: Scanner,
    writer: Writer,
    reader: Reader
  ) {
    this.config = config
    this.choices = choices
    this.available = available
    this.discovery = discovery
    this.store = store
    this.commitGuard = commitGuard
    this.scanner = scanner
    this.writer = writer
    this.reader = reader
  }

  async run(params: RewriteRequest, cwd: string, signal: AbortSignal | undefined): Promise<ToolOutput> {
    const applyId = (params.applyId ?? "").trim()

    if (applyId !== "") {
      return this.commit(applyId)
    }

    const pattern = (params.pattern ?? "").trim()
    const template = params.rewrite

    if (pattern === "" || typeof template !== "string") {
      throw new Error('astrewrite: requires "pattern" and "rewrite" (or "applyId" to commit a staged preview)')
    }

    const collected = await this.discovery.collect(cwd, params.paths, params.lang)
    this.throwIfAllMissing(collected, params.paths)

    const filter = new ProtectFilter(this.config.protectGlobs)
    const allowed: TargetFile[] = []
    const blocked: string[] = []

    for (const file of collected.files) {
      if (filter.isProtected(file)) {
        blocked.push(file.rel)
      } else {
        allowed.push(file)
      }
    }

    const formatter = new RewriteFormatter(this.config, this.choices)

    if (allowed.length === 0) {
      return formatter.nothingToRewrite(pattern, blocked, collected.skippedNoLang)
    }

    const scan = await this.scanner(allowed, pattern, Number.MAX_SAFE_INTEGER, signal)

    if (scan.total === 0) {
      this.throwPatternError(scan, pattern)
      this.throwIfAllUnsupported(scan)

      return formatter.noMatch(pattern, collected, scan.scanned)
    }

    const plan = new EditPlanner(pattern, template).plan(scan.results)

    if (plan.planned.length === 0) {
      return formatter.matchedNoChange(pattern, scan.total, scan.results.length, plan.failures)
    }

    const notes = formatter.notes(blocked, plan.overlapped, plan.failures, collected.capped)

    if (params.apply === true) {
      const outcome = await this.writer(plan.planned)
      const failure = CommitGuard.applyFailure(plan.planned, outcome)

      if (failure) {
        throw failure
      }

      return formatter.applied(pattern, template, plan.replaced, plan.planned, outcome.written, notes)
    }

    this.store.guardBytes(plan.planned)
    const id = this.store.makeId()
    this.store.stage(this.store.build(id, pattern, template, plan.replaced, plan.planned))

    return formatter.staged(id, pattern, template, plan.replaced, plan.planned, notes)
  }

  private async commit(id: string): Promise<ToolOutput> {
    const set = this.commitGuard.require(id)
    this.commitGuard.checkStale(id, set, this.reader)

    const outcome = await this.writer(set.files)
    this.store.delete(id)
    const failure = this.commitGuard.partialFailure(id, set, outcome)

    if (failure) {
      throw failure
    }

    return new RewriteFormatter(this.config, this.choices).commitSuccess(id, set, outcome.written)
  }

  private throwIfAllMissing(collected: Collected, paths: string[] | undefined): void {
    if (collected.missing.length > 0 && collected.missing.length === (paths?.length ?? 0)) {
      throw new Error(`astrewrite: paths not found: ${collected.missing.join(", ")}`)
    }
  }

  private throwPatternError(scan: ScanResult, pattern: string): void {
    if (scan.patternErrors.size > 0 && scan.results.length === 0) {
      const [lang, message] = [...scan.patternErrors.entries()][0]

      throw new RewriteFormatter(this.config, this.choices).patternError("astrewrite", pattern, lang, message)
    }
  }

  private throwIfAllUnsupported(scan: ScanResult): void {
    if (scan.unsupported.size > 0 && scan.scanned === 0) {
      const skipped = [...scan.unsupported.entries()].map(([lang, count]) => `${count} ${lang}`).join(", ")
      const available = this.available.join(", ")

      throw new Error(
        `astrewrite: skipped all candidate files (${skipped}): language not available in this @ast-grep/napi build (available: ${available}).`
      )
    }
  }
}
