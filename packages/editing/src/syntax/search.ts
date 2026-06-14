import type { AstConfig } from "./settings.ts"
import type { FileDiscovery, TargetFile } from "./discovery.ts"
import { ScanSession } from "./scan.ts"
import type { ScanResult } from "./scan.ts"
import { Phrase, SearchFormatter } from "./format.ts"
import type { ToolOutput } from "./format.ts"
import { RewriteFormatter } from "./rewrite.ts"

export interface SearchRequest {
  pattern?: string
  lang?: string
  paths?: string[]
  context?: number
  limit?: number
}

export type Scanner = (
  files: TargetFile[],
  pattern: string,
  maxMatches: number,
  signal: AbortSignal | undefined
) => Promise<ScanResult>

export class SearchRunner {
  private readonly config: AstConfig
  private readonly choices: string[]
  private readonly available: string[]
  private readonly discovery: FileDiscovery
  private readonly scanner: Scanner

  constructor(config: AstConfig, choices: string[], available: string[], discovery: FileDiscovery, scanner: Scanner) {
    this.config = config
    this.choices = choices
    this.available = available
    this.discovery = discovery
    this.scanner = scanner
  }

  async run(params: SearchRequest, cwd: string, signal: AbortSignal | undefined): Promise<ToolOutput> {
    const pattern = (params.pattern ?? "").trim()

    if (pattern === "") {
      throw new Error("astsearch: pattern is required")
    }

    const limit = Phrase.clampInt(params.limit, this.config.defaultLimit, 1, 1000)
    const context = Phrase.clampInt(params.context, this.config.contextLines, 0, 50)
    const collected = await this.discovery.collect(cwd, params.paths, params.lang)
    const formatter = new SearchFormatter(this.config, this.choices, this.available)

    if (collected.files.length === 0) {
      this.throwIfAllMissing(collected, params.paths)

      return formatter.emptyFiles(collected, ScanSession.empty(), cwd, params.paths, limit)
    }

    const scan = await this.scanner(collected.files, pattern, limit, signal)
    const notes = formatter.notes(collected, scan, limit)

    if (scan.total === 0) {
      this.throwPatternError(scan, pattern)

      return formatter.noMatch(collected, scan, pattern, notes)
    }

    return formatter.hits(scan, pattern, limit, context, notes)
  }

  private throwIfAllMissing(collected: { missing: string[] }, paths: string[] | undefined): void {
    if (collected.missing.length > 0 && collected.missing.length === (paths?.length ?? 0)) {
      throw new Error(`astsearch: paths not found: ${collected.missing.join(", ")}`)
    }
  }

  private throwPatternError(scan: ScanResult, pattern: string): void {
    if (scan.patternErrors.size > 0 && scan.results.length === 0) {
      const [lang, message] = [...scan.patternErrors.entries()][0]

      throw new RewriteFormatter(this.config, this.choices).patternError("astsearch", pattern, lang, message)
    }
  }
}
