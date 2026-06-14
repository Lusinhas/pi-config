import type { TargetFile } from "./discovery.ts"

export interface MatchRange {
  start: { line: number; column: number; index: number }
  end: { line: number; column: number; index: number }
}

export interface MatchEdit {
  startPos: number
  endPos: number
}

export interface MatchNode {
  range(): MatchRange
  text(): string
  getMatch(name: string): MatchNode | null
  getMultipleMatches(name: string): MatchNode[]
  replace(text: string): MatchEdit
}

export interface RootNode {
  range(): MatchRange
  findAll(pattern: string): MatchNode[]
  commitEdits(edits: MatchEdit[]): string
}

export interface ParsedSource {
  root(): RootNode
}

export interface FileMatch {
  file: TargetFile
  content: string
  root: ParsedSource
  matches: MatchNode[]
}

export interface ReadSource {
  read(file: TargetFile): string
  parse(lang: string, content: string): Promise<ParsedSource>
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

const PARSE_ERROR_SAMPLES = 10

export class ScanReport {
  private readonly unsupported = new Map<string, number>()
  private readonly patternErrors = new Map<string, string>()
  private readonly parseErrors: string[] = []
  private readonly results: FileMatch[] = []
  private parseErrorCount = 0
  private scanned = 0
  private total = 0
  private truncated = false
  private unscanned = 0

  static empty(): ScanResult {
    return {
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
  }

  matchTotal(): number {
    return this.total
  }

  hasPatternError(lang: string): boolean {
    return this.patternErrors.has(lang)
  }

  markUnsupported(lang: string): void {
    this.unsupported.set(lang, (this.unsupported.get(lang) ?? 0) + 1)
  }

  markScanned(): void {
    this.scanned += 1
  }

  markPatternError(lang: string, message: string): void {
    this.patternErrors.set(lang, message)
  }

  markTruncated(unscanned: number): void {
    this.truncated = true
    this.unscanned = unscanned
  }

  markOverflow(): void {
    this.truncated = true
  }

  recordParseError(rel: string): void {
    this.parseErrorCount += 1

    if (this.parseErrors.length < PARSE_ERROR_SAMPLES) {
      this.parseErrors.push(rel)
    }
  }

  recordMatch(match: FileMatch): void {
    this.total += match.matches.length
    this.results.push(match)
  }

  result(): ScanResult {
    return {
      results: this.results,
      scanned: this.scanned,
      total: this.total,
      truncated: this.truncated,
      unscanned: this.unscanned,
      parseErrors: this.parseErrors,
      parseErrorCount: this.parseErrorCount,
      unsupported: this.unsupported,
      patternErrors: this.patternErrors
    }
  }
}

export class ScanSession {
  private readonly files: TargetFile[]
  private readonly pattern: string
  private readonly maxMatches: number
  private readonly supported: Set<string>
  private readonly source: ReadSource
  private readonly signal: AbortSignal | undefined
  private readonly report = new ScanReport()

  constructor(
    files: TargetFile[],
    pattern: string,
    maxMatches: number,
    supported: Set<string>,
    source: ReadSource,
    signal: AbortSignal | undefined
  ) {
    this.files = files
    this.pattern = pattern
    this.maxMatches = maxMatches
    this.supported = supported
    this.source = source
    this.signal = signal
  }

  static empty(): ScanResult {
    return ScanReport.empty()
  }

  async run(): Promise<ScanResult> {
    for (let index = 0; index < this.files.length; index += 1) {
      if (this.signal?.aborted) {
        throw new Error("ast-grep scan aborted")
      }

      if (this.report.matchTotal() >= this.maxMatches) {
        this.report.markTruncated(this.files.length - index)
        break
      }

      await this.scanFile(this.files[index])
    }

    if (this.report.matchTotal() > this.maxMatches) {
      this.report.markOverflow()
    }

    return this.report.result()
  }

  private async scanFile(file: TargetFile): Promise<void> {
    if (this.supported.size > 0 && !this.supported.has(file.lang)) {
      this.report.markUnsupported(file.lang)
      return
    }

    if (this.report.hasPatternError(file.lang)) {
      return
    }

    let content: string

    try {
      content = this.source.read(file)
    } catch {
      this.report.recordParseError(file.rel)
      return
    }

    if (content.includes("\0")) {
      return
    }

    let root: ParsedSource

    try {
      root = await this.source.parse(file.lang, content)
    } catch {
      this.report.recordParseError(file.rel)
      return
    }

    this.report.markScanned()
    let matches: MatchNode[]

    try {
      matches = root.root().findAll(this.pattern)
    } catch (error) {
      this.report.markPatternError(file.lang, error instanceof Error ? error.message : String(error))
      return
    }

    if (matches.length === 0) {
      return
    }

    const match: FileMatch = { file, content, root, matches }
    this.report.recordMatch(match)
  }
}
