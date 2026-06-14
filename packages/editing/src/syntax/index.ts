import type { AstConfig } from "./settings.ts"
import { FileDiscovery } from "./discovery.ts"
import type { GitFiles } from "./discovery.ts"
import type { ToolOutput } from "./format.ts"
import { CommitGuard, RewriteRunner, StagedStore } from "./rewrite.ts"
import type { Reader, RewriteRequest, Writer } from "./rewrite.ts"
import { SearchRunner } from "./search.ts"
import type { Scanner, SearchRequest } from "./search.ts"

export type { AstConfig } from "./settings.ts"
export { Config, Defaults, Sanitizer } from "./settings.ts"
export type { Collected, GitFiles, TargetFile } from "./discovery.ts"
export { FileDiscovery } from "./discovery.ts"
export type { FileMatch, MatchEdit, MatchNode, MatchRange, ParsedSource, ReadSource, RootNode, ScanResult } from "./scan.ts"
export { ScanSession } from "./scan.ts"
export type { ToolOutput, ToolText } from "./format.ts"
export { SearchFormatter } from "./format.ts"
export type { Planned, Reader, RewriteRequest, StagedFile, StagedSet, Writer, WriteOutcome } from "./rewrite.ts"
export { CommitGuard, EditPlanner, Hashing, RewriteFormatter, StagedStore, Substitution } from "./rewrite.ts"
export type { Scanner, SearchRequest } from "./search.ts"
export { SearchRunner } from "./search.ts"
export { DiffEngine } from "./diff.ts"
export { GlobMatcher, ProtectFilter } from "./glob.ts"

export interface CoreDeps {
  config: AstConfig
  choices: string[]
  available: string[]
  gitFiles: GitFiles
  scanner: Scanner
  writer: Writer
  reader: Reader
}

export class Core {
  private readonly search: SearchRunner
  private readonly rewrite: RewriteRunner

  constructor(deps: CoreDeps) {
    const discovery = new FileDiscovery(deps.config, deps.gitFiles)
    const store = new StagedStore(deps.config.maxStaged)
    const commitGuard = new CommitGuard(store, deps.config.maxStaged)

    this.search = new SearchRunner(deps.config, deps.choices, deps.available, discovery, deps.scanner)
    this.rewrite = new RewriteRunner(
      deps.config,
      deps.choices,
      deps.available,
      discovery,
      store,
      commitGuard,
      deps.scanner,
      deps.writer,
      deps.reader
    )
  }

  runSearch(params: SearchRequest, cwd: string, signal: AbortSignal | undefined): Promise<ToolOutput> {
    return this.search.run(params, cwd, signal)
  }

  runRewrite(params: RewriteRequest, cwd: string, signal: AbortSignal | undefined): Promise<ToolOutput> {
    return this.rewrite.run(params, cwd, signal)
  }
}
