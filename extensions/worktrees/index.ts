import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createWorktree, detectRepo, isInside, pruneWorktrees, removeWorktree, worktreeBase } from "./manage"
import type { WorktreeConfig } from "./manage"
import { openWorktree } from "./launch"

interface SessionStartEvent {
  reason: string
  previousSessionFile?: string
}

const FALLBACK: WorktreeConfig = {
  dir: ".worktrees",
  branchPrefix: "wt/",
  includeFile: ".worktreeinclude",
  defaultRef: "HEAD",
  allowSpawn: false,
  spawnCommand: "pi",
  confirmRemove: true,
  maxIncludeFiles: 500,
  gitTimeoutMs: 30000
}

const SUBCOMMANDS = ["list", "new", "open", "rm", "clean"]

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
    return (source as Record<string, unknown>)["worktrees"]
  }
  return undefined
}

function sanitizeConfig(raw: Record<string, unknown>): WorktreeConfig {
  const str = (value: unknown, fallback: string): string =>
    typeof value === "string" && value.trim() ? value.trim() : fallback
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback)
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
  const prefix = typeof raw.branchPrefix === "string" ? raw.branchPrefix.trim() : FALLBACK.branchPrefix
  return {
    dir: str(raw.dir, FALLBACK.dir),
    branchPrefix: /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(prefix) ? prefix : FALLBACK.branchPrefix,
    includeFile: str(raw.includeFile, FALLBACK.includeFile),
    defaultRef: str(raw.defaultRef, FALLBACK.defaultRef),
    allowSpawn: bool(raw.allowSpawn, FALLBACK.allowSpawn),
    spawnCommand: str(raw.spawnCommand, FALLBACK.spawnCommand),
    confirmRemove: bool(raw.confirmRemove, FALLBACK.confirmRemove),
    maxIncludeFiles: num(raw.maxIncludeFiles, FALLBACK.maxIncludeFiles),
    gitTimeoutMs: num(raw.gitTimeoutMs, FALLBACK.gitTimeoutMs)
  }
}

function loadConfig(): WorktreeConfig {
  let merged: Record<string, unknown> = { ...FALLBACK }
  try {
    const shipped = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))
    merged = deepMerge(merged, shipped)
  } catch {}
  merged = deepMerge(merged, overlayFrom(readJson(join(homedir(), ".pi", "agent", "piconfig.json"))))
  merged = deepMerge(merged, overlayFrom(readJson(join(process.cwd(), ".pi", "piconfig.json"))))
  return sanitizeConfig(merged)
}

function emit(ctx: ExtensionContext, text: string, severity: "info" | "warning" | "error"): void {
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

function usage(config: WorktreeConfig): string {
  return [
    "Usage: /worktree <subcommand>",
    "  list               show every worktree registered for this repo",
    `  new <name> [ref]   create ${config.dir}/<name> on branch ${config.branchPrefix}<name> (ref defaults to ${config.defaultRef})`,
    "  open <name>        print how to launch pi inside a worktree",
    "  rm <name>          remove a worktree after a dirty check and confirmation",
    "  clean              prune stale worktree registrations"
  ].join("\n")
}

function shortHead(head: string): string {
  return head ? head.slice(0, 9) : "-"
}

async function renderList(pi: ExtensionAPI, ctx: ExtensionContext, config: WorktreeConfig): Promise<string> {
  const repo = await detectRepo(pi, ctx.cwd, config)
  const base = worktreeBase(config, repo.mainRoot)
  const rows = repo.entries.map(entry => {
    const marker = isInside(ctx.cwd, entry.path) ? "*" : " "
    const kind = entry.isMain ? "main" : isInside(entry.path, base) ? "managed" : "linked"
    const branch = entry.bare
      ? "(bare)"
      : entry.detached
        ? `(detached ${shortHead(entry.head)})`
        : entry.branch ?? "-"
    const flags: string[] = []
    if (entry.locked) flags.push(entry.lockedReason ? `locked: ${entry.lockedReason}` : "locked")
    if (entry.prunable) flags.push(entry.prunableReason ? `prunable: ${entry.prunableReason}` : "prunable")
    return {
      marker,
      name: basename(entry.path) || entry.path,
      kind,
      branch,
      head: shortHead(entry.head),
      path: entry.path,
      flags: flags.join(", ")
    }
  })
  const nameWidth = Math.max(4, ...rows.map(row => row.name.length))
  const kindWidth = Math.max(4, ...rows.map(row => row.kind.length))
  const branchWidth = Math.max(6, ...rows.map(row => row.branch.length))
  const lines = rows.map(row => {
    const flagText = row.flags ? `  [${row.flags}]` : ""
    return `${row.marker} ${row.name.padEnd(nameWidth)}  ${row.kind.padEnd(kindWidth)}  ${row.branch.padEnd(branchWidth)}  ${row.head.padEnd(9)}  ${row.path}${flagText}`
  })
  return `Worktrees (${rows.length}):\n${lines.join("\n")}\n* = contains the current session cwd`
}

export default function worktrees(pi: ExtensionAPI): void {
  const config = loadConfig()

  pi.registerFlag("worktree", {
    description: "Create or reuse the named git worktree at startup; prints restart instructions if the session is not already inside it",
    type: "string",
    default: ""
  })

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const value = pi.getFlag("worktree")
    if (typeof value !== "string") return
    const name = value.trim()
    if (!name) return
    try {
      const outcome = await createWorktree(pi, ctx.cwd, config, name, undefined)
      if (isInside(ctx.cwd, outcome.path)) {
        emit(ctx, `Worktree "${name}" active: this session is running inside ${outcome.path}.`, "info")
        return
      }
      const verb = outcome.created ? "created" : "already exists"
      const copyNote = outcome.copied > 0 ? ` Copied ${outcome.copied} file(s) matching ${config.includeFile}.` : ""
      emit(
        ctx,
        `Worktree "${name}" ${verb} at ${outcome.path} (branch ${outcome.branch}).${copyNote} This session runs in ${ctx.cwd} and pi cannot relocate its cwd mid-session; restart inside the worktree:\n  cd ${outcome.path} && pi`,
        "warning"
      )
    } catch (error) {
      emit(ctx, `--worktree ${name}: ${error instanceof Error ? error.message : String(error)}`, "error")
    }
  })

  pi.registerCommand("worktree", {
    description: "Manage git worktrees: list | new <name> [ref] | open <name> | rm <name> | clean",
    getArgumentCompletions: (prefix: string) => {
      const head = (prefix ?? "").trim().split(/\s+/)[0] ?? ""
      const matches = SUBCOMMANDS.filter(sub => sub.startsWith(head))
      return matches.length > 0 ? matches.map(sub => ({ value: sub, label: sub })) : null
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean)
      const sub = tokens[0] ?? "list"
      try {
        if (sub === "list" || sub === "ls") {
          emit(ctx, await renderList(pi, ctx, config), "info")
        } else if (sub === "new" || sub === "add" || sub === "create") {
          const name = tokens[1]
          if (!name) {
            emit(ctx, `Missing worktree name.\n${usage(config)}`, "warning")
            return
          }
          const outcome = await createWorktree(pi, ctx.cwd, config, name, tokens[2])
          const lines: string[] = []
          if (outcome.created) {
            lines.push(`Created worktree "${outcome.name}" at ${outcome.path} on branch ${outcome.branch} from ${outcome.ref}.`)
            if (outcome.copied > 0) lines.push(`Copied ${outcome.copied} file(s) matching ${config.includeFile}.`)
            if (outcome.copyFailed > 0) lines.push(`${outcome.copyFailed} include file(s) failed to copy.`)
          } else {
            lines.push(`Worktree "${outcome.name}" already exists at ${outcome.path} (branch ${outcome.branch}).`)
          }
          lines.push(...outcome.notes)
          lines.push(`Open it with: cd ${outcome.path} && pi`)
          lines.push(`Subagent isolation: pass the path as task context, e.g. context: "Work only inside ${outcome.path}".`)
          emit(ctx, lines.join("\n"), outcome.copyFailed > 0 ? "warning" : "info")
        } else if (sub === "open") {
          const name = tokens[1]
          if (!name) {
            emit(ctx, `Missing worktree name.\n${usage(config)}`, "warning")
            return
          }
          const result = await openWorktree(pi, ctx, config, name)
          emit(ctx, result.text, result.severity)
        } else if (sub === "rm" || sub === "remove") {
          const name = tokens[1]
          if (!name) {
            emit(ctx, `Missing worktree name.\n${usage(config)}`, "warning")
            return
          }
          const outcome = await removeWorktree(pi, ctx, config, name)
          emit(ctx, outcome.message, outcome.removed ? "info" : "warning")
        } else if (sub === "clean" || sub === "prune") {
          emit(ctx, await pruneWorktrees(pi, ctx.cwd, config), "info")
        } else {
          emit(ctx, `Unknown subcommand "${sub}".\n${usage(config)}`, "warning")
        }
      } catch (error) {
        emit(ctx, error instanceof Error ? error.message : String(error), "error")
      }
    }
  })
}
