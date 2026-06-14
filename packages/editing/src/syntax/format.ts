import type { AstConfig } from "./settings.ts"
import type { Collected } from "./discovery.ts"
import type { FileMatch, MatchRange, ScanResult } from "./scan.ts"

export interface ToolText {
  type: "text"
  text: string
}

export interface ToolOutput {
  content: ToolText[]
  details: Record<string, unknown>
}

const SNIPPET_CLIP = 200

export class Phrase {
  static clip(line: string, max: number): string {
    if (line.length <= max) {
      return line
    }

    return `${line.slice(0, max)}…`
  }

  static plural(count: number, word: string, pluralWord?: string): string {
    return `${count} ${count === 1 ? word : pluralWord ?? `${word}s`}`
  }

  static clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback
    }

    return Math.min(max, Math.max(min, Math.floor(value)))
  }
}

export class FileLines {
  private readonly lines: string[]

  constructor(content: string) {
    const lines = content.split("\n")

    if (lines.length > 1 && lines[lines.length - 1] === "") {
      lines.pop()
    }

    this.lines = lines
  }

  contextBlock(startLine: number, endLine: number, context: number): string[] {
    const from = Math.max(0, startLine - context)
    const to = Math.min(this.lines.length - 1, endLine + context)
    const width = String(to + 1).length
    const block: string[] = []

    for (let index = from; index <= to; index += 1) {
      const marker = index >= startLine && index <= endLine ? ">" : " "
      block.push(`    ${marker} ${String(index + 1).padStart(width)} | ${Phrase.clip(this.lines[index], SNIPPET_CLIP)}`)
    }

    return block
  }
}

export class Output {
  private readonly lines: string[] = []

  push(line: string): void {
    this.lines.push(line)
  }

  blank(): void {
    this.lines.push("")
  }

  notes(notes: string[]): void {
    if (notes.length === 0) {
      return
    }

    this.lines.push("")

    for (const note of notes) {
      this.lines.push(`Note: ${note}`)
    }
  }

  inlineNotes(notes: string[]): void {
    for (const note of notes) {
      this.lines.push(`Note: ${note}`)
    }
  }

  build(details: Record<string, unknown>): ToolOutput {
    return { content: [{ type: "text", text: this.lines.join("\n") }], details }
  }

  static text(text: string, details: Record<string, unknown>): ToolOutput {
    return { content: [{ type: "text", text }], details }
  }
}

export class SearchFormatter {
  private readonly config: AstConfig
  private readonly choices: string[]
  private readonly availableLangs: string[]

  constructor(config: AstConfig, choices: string[], availableLangs: string[]) {
    this.config = config
    this.choices = choices
    this.availableLangs = availableLangs
  }

  static snippetOf(text: string): string {
    const lines = text.split("\n")
    const first = Phrase.clip(lines[0].trim(), SNIPPET_CLIP)

    if (lines.length === 1) {
      return first
    }

    return `${first} … (+${lines.length - 1} more lines)`
  }

  static endLineOf(range: MatchRange): number {
    if (range.end.line > range.start.line && range.end.column === 0) {
      return range.end.line - 1
    }

    return range.end.line
  }

  static searchedLangs(collected: Collected): string[] {
    return [...new Set(collected.files.map((file) => file.lang))].sort()
  }

  notes(collected: Collected, scan: ScanResult, limit: number): string[] {
    const notes: string[] = []

    if (scan.truncated) {
      const tail = scan.unscanned > 0 ? `; ${Phrase.plural(scan.unscanned, "file")} not scanned yet` : ""
      notes.push(`Match limit ${limit} reached${tail}. Narrow paths or raise limit to see more.`)
    }

    if (collected.capped) {
      notes.push(`File scan capped at ${this.config.fileLimit} files (fileLimit config).`)
    }

    const available = this.availableLangs.join(", ")

    for (const [lang, count] of scan.unsupported) {
      notes.push(
        `Skipped ${Phrase.plural(count, `${lang} file`)}: language not available in this @ast-grep/napi build (available: ${available}).`
      )
    }

    for (const [lang, message] of scan.patternErrors) {
      notes.push(`Pattern failed to parse as ${lang}: ${Phrase.clip(message, SNIPPET_CLIP)}`)
    }

    if (scan.parseErrorCount > 0) {
      notes.push(`${Phrase.plural(scan.parseErrorCount, "file")} could not be read or parsed (e.g. ${scan.parseErrors.join(", ")}).`)
    }

    if (collected.missing.length > 0) {
      notes.push(`Paths not found: ${collected.missing.join(", ")}.`)
    }

    if (collected.skippedLarge > 0) {
      notes.push(`Skipped ${Phrase.plural(collected.skippedLarge, "file")} larger than ${this.config.maxFileBytes} bytes (maxFileBytes config).`)
    }

    return notes
  }

  emptyFiles(collected: Collected, emptyScan: ScanResult, cwd: string, paths: string[] | undefined, limit: number): ToolOutput {
    const extensions = Object.keys(this.config.langMap).sort().join(", ")
    const output = new Output()

    output.push(`No searchable files found${paths && paths.length > 0 ? ` under: ${paths.join(", ")}` : ` under ${cwd}`}.`)
    output.push(`Files are selected by extension (${extensions}); ${collected.skippedNoLang} files had no mapped language.`)
    output.inlineNotes(this.notes(collected, emptyScan, limit))

    return output.build({ total: 0, files: [] })
  }

  noMatch(collected: Collected, scan: ScanResult, pattern: string, notes: string[]): ToolOutput {
    const langs = SearchFormatter.searchedLangs(collected)
    const output = new Output()

    output.push(`No matches for pattern "${pattern}".`)
    output.push(`Searched ${scan.scanned} files (inferred languages: ${langs.join(", ") || "none"}).`)
    output.push("Patterns must be complete, parsable code in the target language; $NAME matches one node, $$$NAME matches a list.")
    output.push(`If the inferred language is wrong, pass lang explicitly (choices: ${this.choices.join(", ")}).`)
    output.inlineNotes(notes)

    return output.build({ pattern, total: 0, scanned: scan.scanned, languages: langs })
  }

  hits(scan: ScanResult, pattern: string, limit: number, context: number, notes: string[]): ToolOutput {
    const shown = Math.min(scan.total, limit)
    const output = new Output()

    output.push(
      scan.truncated || scan.total > limit
        ? `Found ${scan.total}${scan.truncated && scan.unscanned > 0 ? "+" : ""} matches in ${Phrase.plural(scan.results.length, "file")}; showing first ${shown}.`
        : `Found ${Phrase.plural(scan.total, "match", "matches")} in ${Phrase.plural(scan.results.length, "file")}.`
    )

    const detailFiles: Array<Record<string, unknown>> = []
    let budget = limit

    for (const result of scan.results) {
      if (budget <= 0) {
        break
      }

      output.blank()
      output.push(`${result.file.rel} (${Phrase.plural(result.matches.length, "match", "matches")})`)
      const detailMatches: Array<Record<string, unknown>> = []
      const fileLines = context > 0 ? new FileLines(result.content) : undefined

      budget = this.appendMatches(result, fileLines, context, budget, output, detailMatches)
      detailFiles.push({ path: result.file.rel, lang: result.file.lang, matches: detailMatches })
    }

    output.notes(notes)

    return output.build({ pattern, total: scan.total, shown, truncated: scan.truncated || scan.total > limit, files: detailFiles })
  }

  private appendMatches(
    result: FileMatch,
    fileLines: FileLines | undefined,
    context: number,
    budget: number,
    output: Output,
    detailMatches: Array<Record<string, unknown>>
  ): number {
    let remaining = budget

    for (const match of result.matches) {
      if (remaining <= 0) {
        output.push("  … remaining matches in this file omitted")
        break
      }

      remaining -= 1
      const range = match.range()
      const endLine = SearchFormatter.endLineOf(range)
      output.push(`  ${range.start.line + 1}:${range.start.column + 1}  ${SearchFormatter.snippetOf(match.text())}`)

      if (context > 0 && fileLines) {
        for (const line of fileLines.contextBlock(range.start.line, endLine, context)) {
          output.push(line)
        }
      }

      detailMatches.push({
        line: range.start.line + 1,
        col: range.start.column + 1,
        text: Phrase.clip(match.text(), SNIPPET_CLIP)
      })
    }

    return remaining
  }
}
