import { readdirSync, statSync } from "node:fs"
import type { Dirent } from "node:fs"
import { join, resolve } from "node:path"
import type { CheckpointConfig } from "./config.ts"
import type { SnapshotOutcome, SnapshotStore } from "./index.ts"
import type { RewindSeverity } from "./rewind.ts"

export interface CheckpointSummary {
  saved: number
  skippedOutside: string[]
  skippedLarge: string[]
  skippedOther: string[]
  failed: string[]
  truncated: boolean
}

export class CheckpointPlanner {
  private readonly store: SnapshotStore
  private readonly config: CheckpointConfig

  constructor(store: SnapshotStore, config: CheckpointConfig) {
    this.store = store
    this.config = config
  }

  collectTargets(root: string, paths: string[]): { targets: string[]; truncated: boolean } {
    const targets: string[] = []
    let truncated = false
    const limit = this.config.maxCheckpointFiles

    for (const rel of paths) {
      if (targets.length >= limit) {
        truncated = true
        break
      }

      const abs = resolve(root, rel)

      if (this.isDirectory(abs)) {
        this.collectFiles(abs, targets, limit)

        if (targets.length >= limit) {
          truncated = true
        }
      } else {
        targets.push(abs)
      }
    }

    return { targets, truncated }
  }

  snapshot(toolCallId: string, targets: string[], cwd: string, label: string, truncated: boolean): CheckpointSummary {
    const summary: CheckpointSummary = {
      saved: 0,
      skippedOutside: [],
      skippedLarge: [],
      skippedOther: [],
      failed: [],
      truncated
    }

    for (const abs of targets.slice(0, this.config.maxCheckpointFiles)) {
      const outcome: SnapshotOutcome = this.store.snapshotNow(toolCallId, abs, cwd, label)

      if (outcome === "saved") {
        summary.saved++
      } else if (outcome === "outside") {
        summary.skippedOutside.push(abs)
      } else if (outcome === "toolarge") {
        summary.skippedLarge.push(abs)
      } else if (outcome === "skipped") {
        summary.skippedOther.push(abs)
      } else {
        summary.failed.push(abs)
      }
    }

    this.store.maybePrune()

    return summary
  }

  summaryText(label: string, summary: CheckpointSummary): { text: string; severity: RewindSeverity } {
    const parts = [`Checkpoint "${label}": ${summary.saved} file(s) saved`]

    if (summary.skippedLarge.length > 0) {
      parts.push(`${summary.skippedLarge.length} skipped as too large`)
    }

    if (summary.skippedOther.length > 0) {
      parts.push(`${summary.skippedOther.length} skipped as non-regular`)
    }

    if (summary.failed.length > 0) {
      parts.push(`${summary.failed.length} failed`)
    }

    if (summary.truncated) {
      parts.push(`file list truncated at ${this.config.maxCheckpointFiles}`)
    }

    let text = parts.join(", ")

    if (summary.skippedOutside.length > 0) {
      const shown = summary.skippedOutside
        .slice(0, 5)
        .map(path => `  ${path}`)
        .join("\n")
      const more =
        summary.skippedOutside.length > 5 ? `\n  … and ${summary.skippedOutside.length - 5} more` : ""
      text += `\nSkipped (outside cwd):\n${shown}${more}`
    }

    return { text, severity: summary.failed.length > 0 ? "warning" : "info" }
  }

  private isDirectory(abs: string): boolean {
    try {
      return statSync(abs).isDirectory()
    } catch {
      return false
    }
  }

  private collectFiles(dir: string, sink: string[], limit: number): void {
    if (sink.length >= limit) {
      return
    }

    let items: Dirent[]

    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const item of items) {
      if (sink.length >= limit) {
        return
      }

      const full = join(dir, item.name)

      if (item.isDirectory()) {
        this.collectFiles(full, sink, limit)
      } else if (item.isFile()) {
        sink.push(full)
      }
    }
  }
}
