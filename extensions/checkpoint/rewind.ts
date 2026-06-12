import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent"
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { CheckpointConfig, LabelGroup, ManifestEntry, SnapshotStore } from "./snapshots"

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

export function emit(ctx: ExtensionContext, text: string, severity: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, severity)
    return
  }
  if (ctx.mode === "rpc" || ctx.mode === "json") {
    process.stderr.write(`${text}\n`)
    return
  }
  process.stdout.write(`${text}\n`)
}

export function buildPlan(
  store: SnapshotStore,
  entries: ManifestEntry[],
  firstIndex: number,
  cwd: string
): PlanItem[] {
  const oldestPerPath = new Map<string, ManifestEntry>()
  for (let i = firstIndex; i < entries.length; i++) {
    const entry = entries[i]
    if (!oldestPerPath.has(entry.path)) oldestPerPath.set(entry.path, entry)
  }
  const ordered = [...oldestPerPath.values()].sort((a, b) => b.ts - a.ts)
  const items: PlanItem[] = []
  for (const entry of ordered) {
    const rel = relative(resolve(cwd), entry.path)
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      items.push({ entry, action: "skip", note: "outside cwd" })
      continue
    }
    if (entry.hash === null) {
      if (!existsSync(entry.path)) {
        items.push({ entry, action: "unchanged", note: "already absent" })
        continue
      }
      let isDirectory = false
      try {
        isDirectory = statSync(entry.path).isDirectory()
      } catch {
        isDirectory = false
      }
      if (isDirectory) items.push({ entry, action: "skip", note: "path is now a directory" })
      else items.push({ entry, action: "delete", note: "" })
      continue
    }
    if (!store.hasBlob(entry.hash)) {
      items.push({ entry, action: "skip", note: "snapshot data missing" })
      continue
    }
    let current: Buffer | null = null
    try {
      const stat = statSync(entry.path)
      if (stat.isDirectory()) {
        items.push({ entry, action: "skip", note: "path is now a directory" })
        continue
      }
      if (stat.isFile() && stat.size === entry.size) current = readFileSync(entry.path)
    } catch {
      current = null
    }
    if (current && createHash("sha256").update(current).digest("hex") === entry.hash) {
      items.push({ entry, action: "unchanged", note: "already matches" })
      continue
    }
    items.push({ entry, action: "restore", note: "" })
  }
  return items
}

export async function applyPlan(store: SnapshotStore, items: PlanItem[]): Promise<RestoreResult> {
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
      try {
        await withFileMutationQueue(item.entry.path, async () => {
          rmSync(item.entry.path, { force: true })
        })
        result.deleted++
      } catch (error) {
        result.failures.push(`${item.entry.path}: ${errorMessage(error)}`)
      }
      continue
    }
    const content = item.entry.hash ? store.readBlob(item.entry.hash) : null
    if (!content) {
      result.failures.push(`${item.entry.path}: snapshot data unreadable`)
      continue
    }
    try {
      await withFileMutationQueue(item.entry.path, async () => {
        mkdirSync(dirname(item.entry.path), { recursive: true })
        writeFileSync(item.entry.path, content)
      })
      result.restored++
    } catch (error) {
      result.failures.push(`${item.entry.path}: ${errorMessage(error)}`)
    }
  }
  return result
}

export async function runRewind(
  ctx: ExtensionCommandContext,
  store: SnapshotStore,
  config: CheckpointConfig,
  args: string
): Promise<void> {
  store.ensureSession(ctx.sessionManager.getSessionFile())
  const groups = store.groups()
  if (groups.length === 0) {
    emit(ctx, "No checkpoints recorded for this session yet.", "info")
    return
  }
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const dry = tokens.some(token => token === "dry" || token === "preview" || token === "--dry-run")
  const numeric = tokens.find(token => /^\d+$/.test(token))
  const unknown = tokens.filter(
    token => !/^\d+$/.test(token) && token !== "dry" && token !== "preview" && token !== "--dry-run"
  )
  let index = -1
  if (numeric !== undefined) {
    const n = Number.parseInt(numeric, 10)
    if (n < 1 || n > groups.length) {
      emit(ctx, `Checkpoint ${n} not found; ${groups.length} available.\n${listing(groups)}`, "warning")
      return
    }
    index = n - 1
  } else if (unknown.length > 0) {
    emit(ctx, `Usage: /rewind [n] [dry]\n${listing(groups)}`, "warning")
    return
  }
  if (index === -1) {
    if (!ctx.hasUI) {
      emit(
        ctx,
        `Available checkpoints (newest first):\n${listing(groups)}\nRun /rewind <n> to restore or /rewind <n> dry to preview.`,
        "info"
      )
      return
    }
    const options = groups.map((group, i) => optionLabel(group, i))
    const choice = await ctx.ui.select("Rewind to before…", options)
    if (choice === undefined) return
    index = options.indexOf(choice)
    if (index === -1) return
  }
  const group = groups[index]
  const entries = store.readManifest()
  const plan = buildPlan(store, entries, group.firstIndex, ctx.cwd)
  const actionable = plan.filter(item => item.action === "restore" || item.action === "delete")
  const lines = planLines(plan, config.confirmListLimit)
  if (dry) {
    emit(ctx, `Dry run for "${group.label}":\n${lines}`, "info")
    return
  }
  if (actionable.length === 0) {
    emit(ctx, `Nothing to restore for "${group.label}":\n${lines}`, "info")
    return
  }
  if (ctx.hasUI) {
    const restoreOption = `Restore ${actionable.length} file(s)`
    const previewOption = "Preview (dry run)"
    const picked = await ctx.ui.select(`Rewind: ${group.label}`, [restoreOption, previewOption, "Cancel"])
    if (picked === undefined || picked === "Cancel") return
    if (picked === previewOption) {
      emit(ctx, `Dry run for "${group.label}":\n${lines}`, "info")
      return
    }
    const confirmed = await ctx.ui.confirm(
      `Restore ${actionable.length} file(s)?`,
      `${lines}\n\nProceed with restore?`
    )
    if (!confirmed) return
  } else {
    emit(ctx, `Restoring "${group.label}":\n${lines}`, "info")
  }
  const result = await applyPlan(store, plan)
  let summary = `Rewind complete: ${result.restored} restored, ${result.deleted} deleted, ${result.unchanged} unchanged, ${result.skipped} skipped`
  if (result.failures.length > 0) {
    summary += `\nFailures:\n${result.failures.map(failure => `  ${failure}`).join("\n")}`
  }
  emit(ctx, summary, result.failures.length > 0 ? "warning" : "info")
}

function listing(groups: LabelGroup[]): string {
  return groups.map((group, i) => `  ${optionLabel(group, i)}`).join("\n")
}

function optionLabel(group: LabelGroup, index: number): string {
  return `${index + 1}. ${group.label} — ${group.paths.length} file(s), ${timeAgo(group.lastTs)}`
}

function planLines(plan: PlanItem[], limit: number): string {
  const lines = plan.map(item => {
    if (item.action === "restore") return `  ~ ${item.entry.path} (${formatBytes(item.entry.size)})`
    if (item.action === "delete") return `  - ${item.entry.path}`
    if (item.action === "unchanged") return `  = ${item.entry.path} (${item.note})`
    return `  ! ${item.entry.path} (${item.note})`
  })
  if (lines.length > limit) {
    const hidden = lines.length - limit
    return [...lines.slice(0, limit), `  … and ${hidden} more`].join("\n")
  }
  return lines.join("\n")
}

function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
