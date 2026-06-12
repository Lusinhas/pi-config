import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { bashCandidates, checkpointGitWorkingSet, SnapshotStore } from "./snapshots"
import type { CheckpointConfig } from "./snapshots"
import { emit, runRewind } from "./rewind"

interface ToolStartEvent {
  toolCallId: string
  toolName: string
  args: unknown
}

interface ToolResultEvent {
  toolName: string
  toolCallId: string
  isError?: boolean
}

interface PromptEvent {
  prompt: string
}

interface SessionStartEvent {
  reason: string
}

const FALLBACK: CheckpointConfig = {
  maxMb: 200,
  maxAgeDays: 30,
  labelMaxChars: 64,
  maxFileMb: 25,
  maxBashFiles: 20,
  maxCheckpointFiles: 500,
  confirmListLimit: 20,
  bashPatterns: [
    "\\brm\\s",
    "\\bmv\\s",
    "\\bcp\\s",
    ">{1,2}",
    "\\bsed\\b[^|;]*\\s(-i|--in-place)",
    "\\bgit\\s+(checkout|restore|reset|clean|stash)\\b"
  ]
}

const WRITE_TOOLS = new Set(["write", "edit"])

function deepMerge(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const existing = out[key]
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function overlayFrom(source: unknown): unknown {
  if (source && typeof source === "object" && !Array.isArray(source)) {
    return (source as Record<string, unknown>)["checkpoint"]
  }
  return undefined
}

function sanitizeConfig(raw: Record<string, unknown>): CheckpointConfig {
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
  const patterns = Array.isArray(raw.bashPatterns)
    ? raw.bashPatterns.filter((pattern): pattern is string => typeof pattern === "string")
    : FALLBACK.bashPatterns
  return {
    maxMb: num(raw.maxMb, FALLBACK.maxMb),
    maxAgeDays: num(raw.maxAgeDays, FALLBACK.maxAgeDays),
    labelMaxChars: num(raw.labelMaxChars, FALLBACK.labelMaxChars),
    maxFileMb: num(raw.maxFileMb, FALLBACK.maxFileMb),
    maxBashFiles: num(raw.maxBashFiles, FALLBACK.maxBashFiles),
    maxCheckpointFiles: num(raw.maxCheckpointFiles, FALLBACK.maxCheckpointFiles),
    confirmListLimit: num(raw.confirmListLimit, FALLBACK.confirmListLimit),
    bashPatterns: patterns
  }
}

function loadConfig(): CheckpointConfig {
  let merged: Record<string, unknown> = { ...FALLBACK }
  try {
    const shipped = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))
    merged = deepMerge(merged, shipped)
  } catch {}
  merged = deepMerge(merged, overlayFrom(readJson(join(homedir(), ".pi", "agent", "piconfig.json"))))
  merged = deepMerge(merged, overlayFrom(readJson(join(process.cwd(), ".pi", "piconfig.json"))))
  return sanitizeConfig(merged)
}

function pathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null
  const record = args as Record<string, unknown>
  for (const key of ["path", "file_path", "filePath", "filename"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return null
}

function commandFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null
  const value = (args as Record<string, unknown>)["command"]
  return typeof value === "string" && value.trim() ? value : null
}

export default function checkpoint(pi: ExtensionAPI): void {
  const config = loadConfig()
  const store = new SnapshotStore(config)
  let pendingLabel = ""

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    store.ensureSession(ctx.sessionManager.getSessionFile())
    store.resetLabel()
    pendingLabel = ""
    try {
      store.prune()
    } catch {}
  })

  pi.on("before_agent_start", (event: PromptEvent) => {
    pendingLabel = typeof event.prompt === "string" ? store.excerpt(event.prompt) : ""
    return undefined
  })

  pi.on("agent_start", () => {
    if (pendingLabel) {
      store.setLabel(pendingLabel)
      pendingLabel = ""
    }
  })

  pi.on("tool_execution_start", (event: ToolStartEvent, ctx: ExtensionContext) => {
    try {
      if (WRITE_TOOLS.has(event.toolName)) {
        const target = pathFromArgs(event.args)
        if (target) store.capture(event.toolCallId, target, ctx.cwd)
      } else if (event.toolName === "bash") {
        const command = commandFromArgs(event.args)
        if (command && store.matchesBashHeuristic(command)) {
          for (const candidate of bashCandidates(command, ctx.cwd, config.maxBashFiles)) {
            store.capture(event.toolCallId, candidate.path, ctx.cwd)
          }
        }
      }
    } catch {}
  })

  pi.on("tool_result", (event: ToolResultEvent) => {
    try {
      if (WRITE_TOOLS.has(event.toolName) || event.toolName === "bash") {
        if (event.isError) store.discard(event.toolCallId)
        else store.commit(event.toolCallId)
      }
    } catch {}
    return undefined
  })

  pi.on("turn_end", () => {
    store.discardAll()
  })

  pi.on("agent_end", () => {
    store.discardAll()
  })

  pi.registerCommand("checkpoint", {
    description: "Snapshot every file in the git working set (usage: /checkpoint [label])",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      store.ensureSession(ctx.sessionManager.getSessionFile())
      const label = (args ?? "").trim() || `manual checkpoint ${new Date().toISOString()}`
      const outcome = await checkpointGitWorkingSet(pi, ctx, store, config, label)
      if (typeof outcome === "string") {
        emit(ctx, outcome, "warning")
        return
      }
      const parts = [`Checkpoint "${label}": ${outcome.saved} file(s) saved`]
      if (outcome.skippedLarge.length > 0) parts.push(`${outcome.skippedLarge.length} skipped as too large`)
      if (outcome.skippedOther.length > 0) parts.push(`${outcome.skippedOther.length} skipped as non-regular`)
      if (outcome.failed.length > 0) parts.push(`${outcome.failed.length} failed`)
      if (outcome.truncated) parts.push(`file list truncated at ${config.maxCheckpointFiles}`)
      let text = parts.join(", ")
      if (outcome.skippedOutside.length > 0) {
        const shown = outcome.skippedOutside
          .slice(0, 5)
          .map(path => `  ${path}`)
          .join("\n")
        const more =
          outcome.skippedOutside.length > 5 ? `\n  … and ${outcome.skippedOutside.length - 5} more` : ""
        text += `\nSkipped (outside cwd):\n${shown}${more}`
      }
      emit(ctx, text, outcome.failed.length > 0 ? "warning" : "info")
    }
  })

  pi.registerCommand("rewind", {
    description: "Rewind files to a previous checkpoint (usage: /rewind [n] [dry])",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await runRewind(ctx, store, config, args ?? "")
    }
  })
}
