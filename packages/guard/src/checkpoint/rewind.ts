import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { CheckpointConfig, LabelGroup, ManifestEntry } from "./config.ts"
import type { SnapshotStore } from "./index.ts"

export interface PlanItem {
  entry: ManifestEntry
  action: "restore" | "delete" | "unchanged" | "skip"
  note: string
}

export interface RestoreResult {
  restored: number
  deleted: number
  unchanged: number
  skipped: number
  failures: string[]
}

export type MutationQueue = (path: string, fn: () => Promise<void>) => Promise<unknown>

export type RewindSeverity = "info" | "warning"

export interface RewindArgs {
  dry: boolean
  index: number
  unknown: string[]
  numericPresent: boolean
  numericValue: number
}

export class RewindEngine {
  private readonly store: SnapshotStore
  private readonly config: CheckpointConfig
  private readonly queue: MutationQueue

  constructor(store: SnapshotStore, config: CheckpointConfig, queue: MutationQueue) {
    this.store = store
    this.config = config
    this.queue = queue
  }

  parseArgs(args: string, groupCount: number): RewindArgs {
    const tokens = args.trim().split(/\s+/).filter(Boolean)
    const dry = tokens.some(token => token === "dry" || token === "preview" || token === "--dry-run")
    const numeric = tokens.find(token => /^\d+$/.test(token))
    const unknown = tokens.filter(
      token => !/^\d+$/.test(token) && token !== "dry" && token !== "preview" && token !== "--dry-run"
    )

    let index = -1
    let numericPresent = false
    let numericValue = 0

    if (numeric !== undefined) {
      numericPresent = true
      numericValue = Number.parseInt(numeric, 10)

      if (numericValue >= 1 && numericValue <= groupCount) {
        index = numericValue - 1
      }
    }

    return { dry, index, unknown, numericPresent, numericValue }
  }

  buildPlan(entries: ManifestEntry[], firstIndex: number, cwd: string): PlanItem[] {
    const oldestPerPath = new Map<string, ManifestEntry>()

    for (let i = firstIndex; i < entries.length; i++) {
      const entry = entries[i]

      if (!oldestPerPath.has(entry.path)) {
        oldestPerPath.set(entry.path, entry)
      }
    }

    const ordered = [...oldestPerPath.values()].sort((a, b) => b.ts - a.ts)
    const items: PlanItem[] = []

    for (const entry of ordered) {
      items.push(this.classify(entry, cwd))
    }

    return items
  }

  private classify(entry: ManifestEntry, cwd: string): PlanItem {
    const rel = relative(resolve(cwd), entry.path)

    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return { entry, action: "skip", note: "outside cwd" }
    }

    if (entry.hash === null) {
      if (!existsSync(entry.path)) {
        return { entry, action: "unchanged", note: "already absent" }
      }

      if (this.isDirectory(entry.path)) {
        return { entry, action: "skip", note: "path is now a directory" }
      }

      return { entry, action: "delete", note: "" }
    }

    if (!this.store.hasBlob(entry.hash)) {
      return { entry, action: "skip", note: "snapshot data missing" }
    }

    let current: Buffer | null = null

    try {
      const stat = statSync(entry.path)

      if (stat.isDirectory()) {
        return { entry, action: "skip", note: "path is now a directory" }
      }

      if (stat.isFile() && stat.size === entry.size) {
        current = readFileSync(entry.path)
      }
    } catch {
      current = null
    }

    if (current && createHash("sha256").update(current).digest("hex") === entry.hash) {
      return { entry, action: "unchanged", note: "already matches" }
    }

    return { entry, action: "restore", note: "" }
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  async applyPlan(items: PlanItem[]): Promise<RestoreResult> {
    const result: RestoreResult = { restored: 0, deleted: 0, unchanged: 0, skipped: 0, failures: [] }

    for (const item of items) {
      if (item.action === "skip") {
        result.skipped++
        continue
      }

      if (item.action === "unchanged") {
        result.unchanged++
        continue
      }

      if (item.action === "delete") {
        await this.runDelete(item, result)
        continue
      }

      await this.runRestore(item, result)
    }

    return result
  }

  private async runDelete(item: PlanItem, result: RestoreResult): Promise<void> {
    try {
      await this.queue(item.entry.path, async () => {
        rmSync(item.entry.path, { force: true })
      })
      result.deleted++
    } catch (error) {
      result.failures.push(`${item.entry.path}: ${errorMessage(error)}`)
    }
  }

  private async runRestore(item: PlanItem, result: RestoreResult): Promise<void> {
    const content = item.entry.hash ? this.store.readBlob(item.entry.hash) : null

    if (!content) {
      result.failures.push(`${item.entry.path}: snapshot data unreadable`)
      return
    }

    try {
      await this.queue(item.entry.path, async () => {
        mkdirSync(dirname(item.entry.path), { recursive: true })
        writeFileSync(item.entry.path, content)
      })
      result.restored++
    } catch (error) {
      result.failures.push(`${item.entry.path}: ${errorMessage(error)}`)
    }
  }

  listing(groups: LabelGroup[]): string {
    return groups.map((group, i) => `  ${this.optionLabel(group, i)}`).join("\n")
  }

  optionLabel(group: LabelGroup, index: number): string {
    return `${index + 1}. ${group.label} — ${group.paths.length} file(s), ${this.timeAgo(group.lastTs)}`
  }

  planLines(plan: PlanItem[]): string {
    const limit = this.config.confirmListLimit
    const lines = plan.map(item => {
      if (item.action === "restore") {
        return `  ~ ${item.entry.path} (${this.formatBytes(item.entry.size)})`
      }

      if (item.action === "delete") {
        return `  - ${item.entry.path}`
      }

      if (item.action === "unchanged") {
        return `  = ${item.entry.path} (${item.note})`
      }

      return `  ! ${item.entry.path} (${item.note})`
    })

    if (lines.length > limit) {
      const hidden = lines.length - limit

      return [...lines.slice(0, limit), `  … and ${hidden} more`].join("\n")
    }

    return lines.join("\n")
  }

  summarize(result: RestoreResult): { text: string; severity: RewindSeverity } {
    let text = `Rewind complete: ${result.restored} restored, ${result.deleted} deleted, ${result.unchanged} unchanged, ${result.skipped} skipped`

    if (result.failures.length > 0) {
      text += `\nFailures:\n${result.failures.map(failure => `  ${failure}`).join("\n")}`
    }

    return { text, severity: result.failures.length > 0 ? "warning" : "info" }
  }

  private timeAgo(ts: number): string {
    const diff = Math.max(0, Date.now() - ts)
    const minutes = Math.floor(diff / 60000)

    if (minutes < 1) {
      return "just now"
    }

    if (minutes < 60) {
      return `${minutes}m ago`
    }

    const hours = Math.floor(minutes / 60)

    if (hours < 24) {
      return `${hours}h ago`
    }

    const days = Math.floor(hours / 24)

    return `${days}d ago`
  }

  private formatBytes(size: number): string {
    if (size < 1024) {
      return `${size} B`
    }

    if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)} KB`
    }

    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
