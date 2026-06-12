import { createHash, randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { Type } from "typebox"
import { StringEnum } from "@earendil-works/pi-ai"
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { Edit, SgNode } from "@ast-grep/napi"
import { collectFiles, compileGlobs, isProtected, langChoices, scanMatches, supportedLangs } from "./scan.ts"
import type { AstConfig, Collected, FileMatch, TargetFile } from "./scan.ts"
import { renderFileDiff } from "./preview.ts"

interface ToolText {
  type: "text"
  text: string
}

interface ToolOutput {
  content: ToolText[]
  details: Record<string, unknown>
}

interface RewriteParams {
  pattern?: string
  rewrite?: string
  lang?: string
  paths?: string[]
  apply?: boolean
  applyId?: string
}

interface Planned {
  abs: string
  rel: string
  hash: string
  content: string
  after: string
  matchCount: number
}

interface StagedFile {
  abs: string
  rel: string
  hash: string
  after: string
  matchCount: number
}

interface StagedSet {
  id: string
  createdAt: number
  pattern: string
  rewrite: string
  totalMatches: number
  files: StagedFile[]
}

const staged = new Map<string, StagedSet>()
const TOKEN = /\$\$\$[A-Z_][A-Z0-9_]*|\$[A-Z_][A-Z0-9_]*/g
const DIFF_CONTEXT = 3
const MAX_STAGE_BYTES = 67108864
const CLIP = 200

function clipLine(line: string, max: number): string {
  if (line.length <= max) return line
  return `${line.slice(0, max)}…`
}

function plural(count: number, word: string, pluralWord?: string): string {
  return `${count} ${count === 1 ? word : pluralWord ?? `${word}s`}`
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function makeId(): string {
  let id = randomBytes(3).toString("hex")
  while (staged.has(id)) id = randomBytes(3).toString("hex")
  return id
}

function substitute(template: string, pattern: string, match: SgNode, source: string): string {
  return template.replace(TOKEN, (token) => {
    const multi = token.startsWith("$$$")
    const name = multi ? token.slice(3) : token.slice(1)
    if (!pattern.includes(multi ? `$$$${name}` : `$${name}`)) return token
    try {
      if (multi) {
        const nodes = match.getMultipleMatches(name)
        if (!Array.isArray(nodes) || nodes.length === 0) return ""
        const start = nodes[0].range().start.index
        const end = nodes[nodes.length - 1].range().end.index
        return source.slice(start, end)
      }
      const captured = match.getMatch(name)
      return captured ? captured.text() : token
    } catch {
      return token
    }
  })
}

function planEdits(
  results: FileMatch[],
  pattern: string,
  template: string
): { planned: Planned[]; replaced: number; overlapped: number; failures: string[] } {
  const planned: Planned[] = []
  const failures: string[] = []
  let replaced = 0
  let overlapped = 0
  for (const result of results) {
    let edits: Edit[]
    try {
      edits = result.matches.map((match) => match.replace(substitute(template, pattern, match, result.content)))
    } catch (error) {
      failures.push(`${result.file.rel}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    edits.sort((left, right) => left.startPos - right.startPos)
    const kept: Edit[] = []
    let lastEnd = -1
    for (const edit of edits) {
      if (edit.startPos >= lastEnd) {
        kept.push(edit)
        lastEnd = edit.endPos
      } else {
        overlapped += 1
      }
    }
    let after: string
    try {
      const rootNode = result.root.root()
      const span = rootNode.range()
      const head = result.content.slice(0, span.start.index)
      const tail = result.content.slice(span.end.index)
      after = head + rootNode.commitEdits(kept) + tail
    } catch (error) {
      failures.push(`${result.file.rel}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (after === result.content) continue
    replaced += kept.length
    planned.push({
      abs: result.file.abs,
      rel: result.file.rel,
      hash: sha(result.content),
      content: result.content,
      after,
      matchCount: kept.length
    })
  }
  return { planned, replaced, overlapped, failures }
}

async function writeFiles(
  files: Array<{ abs: string; rel: string; hash: string; after: string }>
): Promise<{ written: string[]; raced: string[]; failed: string[] }> {
  const written: string[] = []
  const raced: string[] = []
  const failed: string[] = []
  for (const file of files) {
    await withFileMutationQueue(file.abs, async () => {
      let current: string
      try {
        current = readFileSync(file.abs, "utf8")
      } catch {
        raced.push(file.rel)
        return
      }
      if (sha(current) !== file.hash) {
        raced.push(file.rel)
        return
      }
      try {
        writeFileSync(file.abs, file.after, "utf8")
        written.push(file.rel)
      } catch (error) {
        failed.push(`${file.rel}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }
  return { written, raced, failed }
}

async function commitStaged(id: string, config: AstConfig): Promise<ToolOutput> {
  const set = staged.get(id)
  if (!set) {
    const known = [...staged.keys()]
    throw new Error(
      `astrewrite: no staged rewrite with id "${id}"${known.length > 0 ? ` (staged: ${known.join(", ")})` : ""}. Staged sets live in memory and expire on restart or after ${config.maxStaged} newer stages; re-run astrewrite with pattern and rewrite to stage again.`
    )
  }
  const stale: string[] = []
  for (const file of set.files) {
    try {
      if (sha(readFileSync(file.abs, "utf8")) !== file.hash) stale.push(file.rel)
    } catch {
      stale.push(file.rel)
    }
  }
  if (stale.length > 0) {
    staged.delete(id)
    throw new Error(
      `astrewrite: staged set ${id} is stale; these files changed on disk since staging: ${stale.join(", ")}. Nothing was written. Re-run astrewrite with the pattern and rewrite to re-stage against current contents.`
    )
  }
  const { written, raced, failed } = await writeFiles(set.files)
  staged.delete(id)
  if (raced.length > 0 || failed.length > 0) {
    const problems = [
      raced.length > 0 ? `changed during apply: ${raced.join(", ")}` : "",
      failed.length > 0 ? `write failed: ${failed.join("; ")}` : ""
    ]
      .filter((part) => part !== "")
      .join("; ")
    throw new Error(
      `astrewrite: applied ${written.length} of ${set.files.length} files from ${id}; ${problems}. Re-stage with astrewrite to fix the remaining files.`
    )
  }
  const lines = [
    `Applied rewrite ${id}: ${plural(set.totalMatches, "replacement")} written to ${plural(written.length, "file")}.`
  ]
  for (const file of set.files) {
    lines.push(`  ${file.rel} (${plural(file.matchCount, "replacement")})`)
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { applyId: id, files: written, replaced: set.totalMatches }
  }
}

function noMatchOutput(pattern: string, collected: Collected, scanned: number, choices: string[]): ToolOutput {
  const langs = [...new Set(collected.files.map((file) => file.lang))].sort()
  const lines = [
    `No matches for pattern "${pattern}"; nothing to rewrite.`,
    `Searched ${scanned} files (inferred languages: ${langs.join(", ") || "none"}).`,
    `If the inferred language is wrong, pass lang explicitly (choices: ${choices.join(", ")}).`
  ]
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { pattern, total: 0, scanned, languages: langs }
  }
}

export function registerRewrite(pi: ExtensionAPI, config: AstConfig): void {
  const choices = langChoices(config.langMap)
  pi.registerTool({
    name: "astrewrite",
    label: "AST Rewrite",
    description:
      "Structural search-and-replace using ast-grep AST patterns. pattern and rewrite are real code with metavariables: $NAME captures one AST node, $$$NAME a node list, and captures substitute into rewrite (e.g. pattern \"console.log($MSG)\", rewrite \"logger.info($MSG)\"). By default changes are only staged: a diff preview plus applyId returns; call again with just {\"applyId\": \"<id>\"} to write, or pass apply: true to write immediately. Staged files are hash-checked before apply. lang overrides per-file inference; protectGlobs files are never rewritten.",
    parameters: Type.Object({
      pattern: Type.Optional(Type.String({ description: "ast-grep pattern to match, e.g. console.log($MSG)" })),
      rewrite: Type.Optional(Type.String({ description: "Replacement code; metavariables from pattern are substituted. Empty string deletes matches" })),
      lang: Type.Optional(StringEnum(choices, { description: "Force a language instead of inferring from file extensions" })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Files or directories to rewrite (default: working directory)" })),
      apply: Type.Optional(Type.Boolean({ description: "Write changes immediately instead of staging a preview" })),
      applyId: Type.Optional(Type.String({ description: "Commit a previously staged rewrite by id; ignores other parameters" }))
    }),
    execute: async (
      _toolCallId: string,
      params: RewriteParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ): Promise<ToolOutput> => {
      const applyId = (params.applyId ?? "").trim()
      if (applyId !== "") return commitStaged(applyId, config)
      const pattern = (params.pattern ?? "").trim()
      const template = params.rewrite
      if (pattern === "" || typeof template !== "string") {
        throw new Error('astrewrite: requires "pattern" and "rewrite" (or "applyId" to commit a staged preview)')
      }
      const collected = await collectFiles(pi, ctx.cwd, params.paths, config, params.lang)
      if (collected.missing.length > 0 && collected.missing.length === (params.paths?.length ?? 0)) {
        throw new Error(`astrewrite: paths not found: ${collected.missing.join(", ")}`)
      }
      const matchers = compileGlobs(config.protectGlobs)
      const allowed: TargetFile[] = []
      const blocked: string[] = []
      for (const file of collected.files) {
        if (isProtected(file, matchers)) blocked.push(file.rel)
        else allowed.push(file)
      }
      if (allowed.length === 0) {
        const detail =
          blocked.length > 0
            ? `all ${blocked.length} candidate files are protected by protectGlobs config (e.g. ${blocked.slice(0, 5).join(", ")})`
            : `no files with a mapped language found (${collected.skippedNoLang} files had no mapped extension)`
        return {
          content: [{ type: "text", text: `Nothing to rewrite: ${detail}.` }],
          details: { pattern, total: 0, protectedFiles: blocked.length }
        }
      }
      const scan = await scanMatches(allowed, pattern, Number.MAX_SAFE_INTEGER, signal)
      if (scan.total === 0) {
        if (scan.patternErrors.size > 0 && scan.results.length === 0) {
          const [lang, message] = [...scan.patternErrors.entries()][0]
          throw new Error(
            `astrewrite: pattern "${pattern}" failed against ${lang}: ${clipLine(message, CLIP)}. Patterns must be complete, parsable ${lang} code.`
          )
        }
        if (scan.unsupported.size > 0 && scan.scanned === 0) {
          const skipped = [...scan.unsupported.entries()].map(([lang, count]) => `${count} ${lang}`).join(", ")
          const available = [...supportedLangs()].sort().join(", ")
          throw new Error(
            `astrewrite: skipped all candidate files (${skipped}): language not available in this @ast-grep/napi build (available: ${available}).`
          )
        }
        return noMatchOutput(pattern, collected, scan.scanned, choices)
      }
      const { planned, replaced, overlapped, failures } = planEdits(scan.results, pattern, template)
      if (planned.length === 0) {
        const reason =
          failures.length > 0
            ? `edit computation failed: ${failures.slice(0, 3).join("; ")}`
            : "the rewrite output is identical to the source"
        return {
          content: [
            {
              type: "text",
              text: `Pattern "${pattern}" matched ${plural(scan.total, "time")} in ${plural(scan.results.length, "file")} but produced no changes (${reason}).`
            }
          ],
          details: { pattern, total: scan.total, changedFiles: 0 }
        }
      }
      const notes: string[] = []
      if (blocked.length > 0) {
        notes.push(
          `Skipped ${plural(blocked.length, "protected file")} (protectGlobs config), e.g. ${blocked.slice(0, 5).join(", ")}.`
        )
      }
      if (overlapped > 0) {
        notes.push(`Dropped ${plural(overlapped, "overlapping nested match", "overlapping nested matches")}; re-run after applying to catch them.`)
      }
      if (failures.length > 0) {
        notes.push(`Edit computation failed for ${plural(failures.length, "file")}: ${failures.slice(0, 3).join("; ")}.`)
      }
      if (collected.capped) notes.push(`File scan capped at ${config.fileLimit} files (fileLimit config).`)
      if (params.apply === true) {
        const { written, raced, failed } = await writeFiles(planned)
        if (raced.length > 0 || failed.length > 0) {
          const problems = [
            raced.length > 0 ? `changed during apply: ${raced.join(", ")}` : "",
            failed.length > 0 ? `write failed: ${failed.join("; ")}` : ""
          ]
            .filter((part) => part !== "")
            .join("; ")
          throw new Error(
            `astrewrite: wrote ${written.length} of ${planned.length} files; ${problems}. Re-run astrewrite for the remaining files.`
          )
        }
        const lines = [`Rewrote ${plural(replaced, "match", "matches")} in ${plural(written.length, "file")}.`]
        for (const file of planned) {
          lines.push(`  ${file.rel} (${plural(file.matchCount, "replacement")})`)
        }
        if (notes.length > 0) {
          lines.push("")
          for (const note of notes) lines.push(`Note: ${note}`)
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { pattern, rewrite: template, files: written, replaced }
        }
      }
      const stageBytes = planned.reduce((sum, file) => sum + file.after.length + file.content.length, 0)
      if (stageBytes > MAX_STAGE_BYTES) {
        throw new Error(
          `astrewrite: staging would hold ${stageBytes} bytes in memory (limit ${MAX_STAGE_BYTES}). Narrow paths, or pass apply: true to write directly.`
        )
      }
      const id = makeId()
      staged.set(id, {
        id,
        createdAt: Date.now(),
        pattern,
        rewrite: template,
        totalMatches: replaced,
        files: planned.map((file) => ({
          abs: file.abs,
          rel: file.rel,
          hash: file.hash,
          after: file.after,
          matchCount: file.matchCount
        }))
      })
      while (staged.size > config.maxStaged) {
        const oldest = staged.keys().next().value
        if (oldest === undefined) break
        staged.delete(oldest)
      }
      const lines = [
        `Staged rewrite ${id}: ${plural(replaced, "replacement")} across ${plural(planned.length, "file")}. Nothing has been written yet.`,
        ""
      ]
      let budget = config.maxHunks
      let omittedHunks = 0
      const omittedFiles: string[] = []
      for (const file of planned) {
        const rendered = renderFileDiff(file.rel, file.content, file.after, DIFF_CONTEXT, budget)
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
          `Preview truncated at ${config.maxHunks} hunks; ${omittedHunks} more hunks${omittedFiles.length > 0 ? ` (files without preview: ${omittedFiles.join(", ")})` : ""} not shown.`
        )
      }
      lines.push(
        `To write these changes call astrewrite with {"applyId": "${id}"}. Files are hash-checked at apply time; if any change on disk first, the apply fails and you must re-stage.`
      )
      for (const note of notes) lines.push(`Note: ${note}`)
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
  })
}
