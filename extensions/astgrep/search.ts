import { Type } from "typebox"
import { StringEnum } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { collectFiles, langChoices, scanMatches, supportedLangs } from "./scan.ts"
import type { AstConfig, Collected, ScanResult } from "./scan.ts"

interface ToolText {
  type: "text"
  text: string
}

interface ToolOutput {
  content: ToolText[]
  details: Record<string, unknown>
}

interface SearchParams {
  pattern: string
  lang?: string
  paths?: string[]
  context?: number
  limit?: number
}

interface MatchRange {
  start: { line: number; column: number }
  end: { line: number; column: number }
}

const SNIPPET_CLIP = 200

function clipLine(line: string, max: number): string {
  if (line.length <= max) return line
  return `${line.slice(0, max)}…`
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function snippetOf(text: string): string {
  const lines = text.split("\n")
  const first = clipLine(lines[0].trim(), SNIPPET_CLIP)
  if (lines.length === 1) return first
  return `${first} … (+${lines.length - 1} more lines)`
}

function endLineOf(range: MatchRange): number {
  if (range.end.line > range.start.line && range.end.column === 0) return range.end.line - 1
  return range.end.line
}

function plural(count: number, word: string, pluralWord?: string): string {
  return `${count} ${count === 1 ? word : pluralWord ?? `${word}s`}`
}

function contextBlock(content: string, startLine: number, endLine: number, context: number): string[] {
  const lines = content.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  const from = Math.max(0, startLine - context)
  const to = Math.min(lines.length - 1, endLine + context)
  const width = String(to + 1).length
  const block: string[] = []
  for (let index = from; index <= to; index += 1) {
    const marker = index >= startLine && index <= endLine ? ">" : " "
    block.push(`    ${marker} ${String(index + 1).padStart(width)} | ${clipLine(lines[index], SNIPPET_CLIP)}`)
  }
  return block
}

function buildNotes(collected: Collected, scan: ScanResult, config: AstConfig, limit: number): string[] {
  const notes: string[] = []
  if (scan.truncated) {
    const tail = scan.unscanned > 0 ? `; ${plural(scan.unscanned, "file")} not scanned yet` : ""
    notes.push(`Match limit ${limit} reached${tail}. Narrow paths or raise limit to see more.`)
  }
  if (collected.capped) notes.push(`File scan capped at ${config.fileLimit} files (fileLimit config).`)
  for (const [lang, count] of scan.unsupported) {
    const available = [...supportedLangs()].sort().join(", ")
    notes.push(
      `Skipped ${plural(count, `${lang} file`)}: language not available in this @ast-grep/napi build (available: ${available}).`
    )
  }
  for (const [lang, message] of scan.patternErrors) {
    notes.push(`Pattern failed to parse as ${lang}: ${clipLine(message, SNIPPET_CLIP)}`)
  }
  if (scan.parseErrorCount > 0) {
    notes.push(`${plural(scan.parseErrorCount, "file")} could not be read or parsed (e.g. ${scan.parseErrors.join(", ")}).`)
  }
  if (collected.missing.length > 0) notes.push(`Paths not found: ${collected.missing.join(", ")}.`)
  if (collected.skippedLarge > 0) {
    notes.push(`Skipped ${plural(collected.skippedLarge, "file")} larger than ${config.maxFileBytes} bytes (maxFileBytes config).`)
  }
  return notes
}

function searchedLangs(collected: Collected): string[] {
  return [...new Set(collected.files.map((file) => file.lang))].sort()
}

export function registerSearch(pi: ExtensionAPI, config: AstConfig): void {
  const choices = langChoices(config.langMap)
  pi.registerTool({
    name: "astsearch",
    label: "AST Search",
    description:
      "Structural code search using ast-grep AST patterns (not regex). A pattern is real code with metavariables: $NAME matches one AST node, $$$NAME any number (e.g. \"$FN($$$ARGS)\" finds every call). The pattern must parse as a complete snippet in the target language; lang overrides per-file inference. Searches the working directory, honoring .gitignore in git repos.",
    parameters: Type.Object({
      pattern: Type.String({ description: "ast-grep pattern, e.g. console.log($MSG) or $FN($$$ARGS)" }),
      lang: Type.Optional(StringEnum(choices, { description: "Force a language instead of inferring from file extensions" })),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Files or directories to search (default: working directory)" })),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, description: "Context lines around each match" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum matches to return (default 50)" }))
    }),
    execute: async (
      _toolCallId: string,
      params: SearchParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ): Promise<ToolOutput> => {
      const pattern = (params.pattern ?? "").trim()
      if (pattern === "") throw new Error("astsearch: pattern is required")
      const limit = clampInt(params.limit, config.defaultLimit, 1, 1000)
      const context = clampInt(params.context, config.contextLines, 0, 50)
      const collected = await collectFiles(pi, ctx.cwd, params.paths, config, params.lang)
      if (collected.files.length === 0) {
        if (collected.missing.length > 0 && collected.missing.length === (params.paths?.length ?? 0)) {
          throw new Error(`astsearch: paths not found: ${collected.missing.join(", ")}`)
        }
        const extensions = Object.keys(config.langMap).sort().join(", ")
        const emptyScan: ScanResult = {
          results: [],
          scanned: 0,
          total: 0,
          truncated: false,
          unscanned: 0,
          parseErrors: [],
          parseErrorCount: 0,
          unsupported: new Map(),
          patternErrors: new Map()
        }
        const lines = [
          `No searchable files found${params.paths && params.paths.length > 0 ? ` under: ${params.paths.join(", ")}` : ` under ${ctx.cwd}`}.`,
          `Files are selected by extension (${extensions}); ${collected.skippedNoLang} files had no mapped language.`
        ]
        for (const note of buildNotes(collected, emptyScan, config, limit)) {
          lines.push(`Note: ${note}`)
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { total: 0, files: [] } }
      }
      const scan = await scanMatches(collected.files, pattern, limit, signal)
      const notes = buildNotes(collected, scan, config, limit)
      if (scan.total === 0) {
        if (scan.patternErrors.size > 0 && scan.results.length === 0) {
          const [lang, message] = [...scan.patternErrors.entries()][0]
          throw new Error(
            `astsearch: pattern "${pattern}" failed against ${lang}: ${clipLine(message, SNIPPET_CLIP)}. Patterns must be complete, parsable ${lang} code.`
          )
        }
        const langs = searchedLangs(collected)
        const lines = [
          `No matches for pattern "${pattern}".`,
          `Searched ${scan.scanned} files (inferred languages: ${langs.join(", ") || "none"}).`,
          "Patterns must be complete, parsable code in the target language; $NAME matches one node, $$$NAME matches a list.",
          `If the inferred language is wrong, pass lang explicitly (choices: ${choices.join(", ")}).`
        ]
        for (const note of notes) lines.push(`Note: ${note}`)
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { pattern, total: 0, scanned: scan.scanned, languages: langs }
        }
      }
      const shown = Math.min(scan.total, limit)
      const lines: string[] = []
      lines.push(
        scan.truncated || scan.total > limit
          ? `Found ${scan.total}${scan.truncated && scan.unscanned > 0 ? "+" : ""} matches in ${plural(scan.results.length, "file")}; showing first ${shown}.`
          : `Found ${plural(scan.total, "match", "matches")} in ${plural(scan.results.length, "file")}.`
      )
      const detailFiles: Array<Record<string, unknown>> = []
      let budget = limit
      for (const result of scan.results) {
        if (budget <= 0) break
        lines.push("")
        lines.push(`${result.file.rel} (${plural(result.matches.length, "match", "matches")})`)
        const detailMatches: Array<Record<string, unknown>> = []
        for (const match of result.matches) {
          if (budget <= 0) {
            lines.push("  … remaining matches in this file omitted")
            break
          }
          budget -= 1
          const range = match.range() as MatchRange
          const endLine = endLineOf(range)
          lines.push(`  ${range.start.line + 1}:${range.start.column + 1}  ${snippetOf(match.text())}`)
          if (context > 0) lines.push(...contextBlock(result.content, range.start.line, endLine, context))
          detailMatches.push({
            line: range.start.line + 1,
            col: range.start.column + 1,
            text: clipLine(match.text(), SNIPPET_CLIP)
          })
        }
        detailFiles.push({ path: result.file.rel, lang: result.file.lang, matches: detailMatches })
      }
      if (notes.length > 0) {
        lines.push("")
        for (const note of notes) lines.push(`Note: ${note}`)
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { pattern, total: scan.total, shown, truncated: scan.truncated || scan.total > limit, files: detailFiles }
      }
    }
  })
}
