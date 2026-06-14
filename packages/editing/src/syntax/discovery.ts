import { readdirSync, statSync } from "node:fs"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { AstConfig } from "./settings.ts"

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

export type GitFiles = (dir: string, timeout: number) => Promise<string[] | undefined>

export class Paths {
  static toRel(cwd: string, abs: string): string {
    const rel = relative(cwd, abs)

    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return abs.split(sep).join("/")
    }

    return rel.split(sep).join("/")
  }

  static inferLang(path: string, map: Record<string, string>): string | undefined {
    const ext = extname(path).toLowerCase().replace(/^\./, "")

    if (!ext) {
      return undefined
    }

    return map[ext]
  }
}

export class Accumulator {
  private readonly config: AstConfig
  private readonly cwd: string
  private readonly explicitLang: string | undefined
  private readonly seen = new Set<string>()
  private readonly files: TargetFile[] = []
  private readonly missing: string[] = []
  private skippedNoLang = 0
  private skippedLarge = 0
  private capped = false

  constructor(config: AstConfig, cwd: string, explicitLang: string | undefined) {
    this.config = config
    this.cwd = cwd
    this.explicitLang = explicitLang
  }

  isFull(): boolean {
    return this.files.length >= this.config.fileLimit
  }

  markCapped(): void {
    this.capped = true
  }

  markMissing(root: string): void {
    this.missing.push(root)
  }

  push(abs: string, forced: boolean): void {
    if (this.isFull()) {
      this.capped = true
      return
    }

    if (this.seen.has(abs)) {
      return
    }

    let info

    try {
      info = statSync(abs)
    } catch {
      return
    }

    if (!info.isFile()) {
      return
    }

    this.seen.add(abs)
    const inferred = Paths.inferLang(abs, this.config.langMap)
    const lang = this.explicitLang ?? inferred

    if (!lang) {
      this.skippedNoLang += 1
      return
    }

    if (this.explicitLang && !forced && inferred !== this.explicitLang) {
      return
    }

    if (info.size > this.config.maxFileBytes) {
      this.skippedLarge += 1
      return
    }

    this.files.push({ abs, rel: Paths.toRel(this.cwd, abs), lang })
  }

  result(): Collected {
    return {
      files: this.files,
      missing: this.missing,
      skippedNoLang: this.skippedNoLang,
      skippedLarge: this.skippedLarge,
      capped: this.capped
    }
  }
}

export class DirectoryWalker {
  private readonly cap: number

  constructor(cap: number) {
    this.cap = cap
  }

  walk(dir: string): string[] {
    const out: string[] = []
    this.walkInto(dir, out)

    return out
  }

  private walkInto(dir: string, out: string[]): void {
    if (out.length >= this.cap) {
      return
    }

    let entries

    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (out.length >= this.cap) {
        return
      }

      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue
        }

        this.walkInto(join(dir, entry.name), out)
      } else if (entry.isFile()) {
        out.push(join(dir, entry.name))
      }
    }
  }
}

export class FileDiscovery {
  private readonly config: AstConfig
  private readonly gitFiles: GitFiles

  constructor(config: AstConfig, gitFiles: GitFiles) {
    this.config = config
    this.gitFiles = gitFiles
  }

  static toRel(cwd: string, abs: string): string {
    return Paths.toRel(cwd, abs)
  }

  static inferLang(path: string, map: Record<string, string>): string | undefined {
    return Paths.inferLang(path, map)
  }

  async collect(cwd: string, paths: string[] | undefined, explicitLang: string | undefined): Promise<Collected> {
    const roots = paths && paths.length > 0 ? paths : ["."]
    const accumulator = new Accumulator(this.config, cwd, explicitLang)
    const walker = new DirectoryWalker(Math.max(this.config.fileLimit * 10, 20000))

    for (const root of roots) {
      if (typeof root !== "string" || root.trim() === "") {
        continue
      }

      const abs = resolve(cwd, root)
      let info

      try {
        info = statSync(abs)
      } catch {
        accumulator.markMissing(root)
        continue
      }

      if (info.isFile()) {
        accumulator.push(abs, true)
        continue
      }

      if (!info.isDirectory()) {
        accumulator.markMissing(root)
        continue
      }

      const fromGit = await this.gitFiles(abs, this.config.execTimeout)
      const candidates = fromGit ?? walker.walk(abs)

      for (const candidate of candidates) {
        if (accumulator.isFull()) {
          accumulator.markCapped()
          break
        }

        accumulator.push(candidate, false)
      }
    }

    return accumulator.result()
  }
}
