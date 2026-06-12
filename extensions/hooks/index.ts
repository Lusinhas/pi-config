import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { basePayload, createHistory, dispatchEvent, type DispatchOptions, type History } from "./dispatch"
import { createMonitorManager, type MonitorManager, type MonitorSpec, type MonitorStatus } from "./monitors"
import { EVENT_MAPPING, HOOK_EVENTS, hookConfigPaths, loadHooks, type HookEventName, type LoadedHooks } from "./schema"

interface BackoffConfig {
  initialMs: number
  maxMs: number
  resetAfterMs: number
}

interface HooksConfig {
  shell: string
  defaultTimeoutMs: number
  eventBudgetMs: number
  maxOutputBytes: number
  historySize: number
  monitorMaxLineLength: number
  killGraceMs: number
  backoff: BackoffConfig
  monitors: MonitorSpec[]
  problems: string[]
}

const FALLBACK = {
  shell: "/bin/sh",
  defaultTimeoutMs: 60000,
  eventBudgetMs: 120000,
  maxOutputBytes: 16384,
  historySize: 50,
  monitorMaxLineLength: 2000,
  killGraceMs: 3000,
  backoff: { initialMs: 1000, maxMs: 30000, resetAfterMs: 30000 },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = result[key]
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMerge(current, value)
    } else if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

function normalizeMonitors(value: unknown, problems: string[]): MonitorSpec[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    problems.push("config: monitors must be an array")
    return []
  }
  const specs: MonitorSpec[] = []
  const names = new Set<string>()
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push("config: monitors[" + index + "] must be an object")
      return
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : ""
    const command = typeof entry.command === "string" ? entry.command.trim() : ""
    const when = entry.when === undefined ? "always" : entry.when
    if (name.length === 0) {
      problems.push("config: monitors[" + index + "] is missing a name")
      return
    }
    if (names.has(name)) {
      problems.push('config: monitor "' + name + '" is defined more than once')
      return
    }
    if (command.length === 0) {
      problems.push('config: monitor "' + name + '" is missing a command')
      return
    }
    if (when !== "always") {
      problems.push('config: monitor "' + name + '" has an unsupported when value; only "always" is supported')
      return
    }
    names.add(name)
    specs.push({ name, command, when: "always" })
  })
  return specs
}

function normalizeConfig(merged: Record<string, unknown>): HooksConfig {
  const problems: string[] = []
  const backoff = isRecord(merged.backoff) ? merged.backoff : {}
  const initialMs = positive(backoff.initialMs, FALLBACK.backoff.initialMs)
  return {
    shell: text(merged.shell, FALLBACK.shell),
    defaultTimeoutMs: positive(merged.defaultTimeoutMs, FALLBACK.defaultTimeoutMs),
    eventBudgetMs: positive(merged.eventBudgetMs, FALLBACK.eventBudgetMs),
    maxOutputBytes: positive(merged.maxOutputBytes, FALLBACK.maxOutputBytes),
    historySize: positive(merged.historySize, FALLBACK.historySize),
    monitorMaxLineLength: positive(merged.monitorMaxLineLength, FALLBACK.monitorMaxLineLength),
    killGraceMs: positive(merged.killGraceMs, FALLBACK.killGraceMs),
    backoff: {
      initialMs,
      maxMs: Math.max(initialMs, positive(backoff.maxMs, FALLBACK.backoff.maxMs)),
      resetAfterMs: positive(backoff.resetAfterMs, FALLBACK.backoff.resetAfterMs),
    },
    monitors: normalizeMonitors(merged.monitors, problems),
    problems,
  }
}

function loadConfig(): HooksConfig {
  let merged: Record<string, unknown> = {}
  try {
    const raw = readFileSync(new URL("./config.json", import.meta.url), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed)) merged = parsed
  } catch {
    merged = {}
  }
  const overridePaths = [join(homedir(), ".pi", "agent", "suite.json"), join(process.cwd(), ".pi", "suite.json")]
  for (const path of overridePaths) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (isRecord(parsed) && isRecord(parsed.hooks)) merged = deepMerge(merged, parsed.hooks)
    } catch {
      continue
    }
  }
  return normalizeConfig(merged)
}

function buildReport(
  loaded: LoadedHooks,
  statuses: MonitorStatus[],
  history: History,
  config: HooksConfig,
  cwd: string,
): { text: string; hasProblems: boolean } {
  const lines: string[] = []
  lines.push("Hook event mapping (Claude name -> pi event):")
  for (const name of HOOK_EVENTS) lines.push("  " + name + " -> " + EVENT_MAPPING[name])
  lines.push("")
  lines.push("Config files (merged, project appended):")
  if (loaded.sources.length === 0) {
    lines.push("  none found (looked for " + hookConfigPaths(cwd).join(" and ") + ")")
  } else {
    for (const source of loaded.sources) lines.push("  " + source)
  }
  lines.push("")
  lines.push("Hooks loaded (" + loaded.totalHooks + "):")
  let anyHooks = false
  for (const name of HOOK_EVENTS) {
    const groups = loaded.events[name]
    if (groups.length === 0) continue
    anyHooks = true
    lines.push("  " + name + ":")
    for (const group of groups) {
      const matcher = group.matcherSource.length > 0 ? group.matcherSource : "*"
      for (const hook of group.hooks) {
        lines.push("    [" + matcher + "] " + hook.command + " (timeout " + hook.timeoutMs / 1000 + "s)")
      }
    }
  }
  if (!anyHooks) lines.push("  none")
  const problems = [...loaded.problems, ...config.problems]
  lines.push("")
  lines.push("Validation problems (" + problems.length + "):")
  if (problems.length === 0) lines.push("  none")
  for (const problem of problems) lines.push("  " + problem)
  lines.push("")
  lines.push("Monitors (" + statuses.length + "):")
  if (statuses.length === 0) lines.push("  none configured")
  for (const status of statuses) {
    const pid = status.pid !== null ? " pid " + status.pid : ""
    const last = status.lastExit.length > 0 ? ", last exit " + status.lastExit : ""
    const tail = status.stderrTail.length > 0 ? " | stderr: " + status.stderrTail : ""
    lines.push("  " + status.name + ": " + status.state + pid + ", restarts " + status.restarts + last + tail)
  }
  lines.push("")
  const records = history.list().slice(-15).reverse()
  lines.push("Recent dispatches (newest first, keeping last " + config.historySize + "):")
  if (records.length === 0) lines.push("  none yet")
  for (const record of records) {
    const exit = record.exitCode === null ? "-" : String(record.exitCode)
    const detail = record.detail.length > 0 ? " | " + record.detail : ""
    lines.push(
      "  " +
        record.at.slice(11, 19) +
        " " +
        record.event +
        " " +
        record.outcome +
        " exit " +
        exit +
        " " +
        record.durationMs +
        "ms " +
        record.command +
        detail,
    )
  }
  lines.push("")
  lines.push(
    "Hook timeout field is in seconds (Claude-compatible); default " +
      config.defaultTimeoutMs / 1000 +
      "s per hook, " +
      config.eventBudgetMs / 1000 +
      "s budget per event. Exit 0 continues (stdout becomes context on UserPromptSubmit), exit 2 blocks with stderr as reason, other codes are logged.",
  )
  return { text: lines.join("\n"), hasProblems: problems.length > 0 }
}

export default function hooks(pi: ExtensionAPI): void {
  const config = loadConfig()
  const history = createHistory(config.historySize)
  const options: DispatchOptions = {
    shell: config.shell,
    eventBudgetMs: config.eventBudgetMs,
    maxOutputBytes: config.maxOutputBytes,
  }
  let loaded: LoadedHooks = loadHooks(process.cwd(), config.defaultTimeoutMs)
  const manager: MonitorManager = createMonitorManager(pi, {
    specs: config.monitors,
    backoffInitialMs: config.backoff.initialMs,
    backoffMaxMs: config.backoff.maxMs,
    backoffResetAfterMs: config.backoff.resetAfterMs,
    killGraceMs: config.killGraceMs,
    maxLineLength: config.monitorMaxLineLength,
  })

  function hasHooks(eventName: HookEventName): boolean {
    return loaded.events[eventName].length > 0
  }

  pi.on("tool_call", async (event: { toolName?: unknown; input?: unknown }, ctx: ExtensionContext) => {
    if (!hasHooks("PreToolUse")) return undefined
    try {
      const toolName = typeof event.toolName === "string" ? event.toolName : ""
      const payload = {
        ...basePayload(ctx, "PreToolUse"),
        tool_name: toolName,
        tool_input: event.input ?? {},
      }
      const result = await dispatchEvent(pi, loaded, history, options, "PreToolUse", toolName, payload)
      if (result.blocked) return { block: true, reason: result.reason }
      return undefined
    } catch {
      return undefined
    }
  })

  pi.on(
    "tool_result",
    async (
      event: { toolName?: unknown; input?: unknown; content?: unknown; isError?: unknown },
      ctx: ExtensionContext,
    ) => {
      if (!hasHooks("PostToolUse")) return undefined
      try {
        const toolName = typeof event.toolName === "string" ? event.toolName : ""
        const payload = {
          ...basePayload(ctx, "PostToolUse"),
          tool_name: toolName,
          tool_input: event.input ?? {},
          tool_response: { content: event.content ?? [], is_error: event.isError === true },
        }
        const result = await dispatchEvent(pi, loaded, history, options, "PostToolUse", toolName, payload)
        if (!result.blocked) return undefined
        const existing = Array.isArray(event.content) ? event.content : []
        return { content: [...existing, { type: "text", text: "PostToolUse hook feedback: " + result.reason }] }
      } catch {
        return undefined
      }
    },
  )

  pi.on("input", async (event: { text?: unknown; source?: unknown }, ctx: ExtensionContext) => {
    if (!hasHooks("UserPromptSubmit")) return undefined
    try {
      const promptText = typeof event.text === "string" ? event.text : ""
      const payload = { ...basePayload(ctx, "UserPromptSubmit"), prompt: promptText }
      const result = await dispatchEvent(pi, loaded, history, options, "UserPromptSubmit", null, payload)
      if (result.blocked) {
        if (ctx.hasUI) ctx.ui.notify("Prompt blocked by UserPromptSubmit hook: " + result.reason, "warning")
        return { action: "handled" }
      }
      if (result.context.length > 0 && promptText.length > 0) {
        return { action: "transform", text: promptText + "\n\n" + result.context.join("\n") }
      }
      return undefined
    } catch {
      return undefined
    }
  })

  pi.on("session_start", async (event: { reason?: unknown }, ctx: ExtensionContext) => {
    try {
      loaded = loadHooks(ctx.cwd, config.defaultTimeoutMs)
      manager.start(ctx.cwd)
      if (!hasHooks("SessionStart")) return
      const payload = {
        ...basePayload(ctx, "SessionStart"),
        source: typeof event.reason === "string" ? event.reason : "startup",
      }
      await dispatchEvent(pi, loaded, history, options, "SessionStart", null, payload)
    } catch {
      return
    }
  })

  pi.on("agent_end", async (_event: unknown, ctx: ExtensionContext) => {
    if (!hasHooks("Stop")) return
    try {
      const payload = { ...basePayload(ctx, "Stop"), stop_hook_active: false }
      await dispatchEvent(pi, loaded, history, options, "Stop", null, payload)
    } catch {
      return
    }
  })

  pi.on("session_before_compact", async (event: { customInstructions?: unknown }, ctx: ExtensionContext) => {
    if (!hasHooks("PreCompact")) return undefined
    try {
      const custom = typeof event.customInstructions === "string" ? event.customInstructions : ""
      const payload = {
        ...basePayload(ctx, "PreCompact"),
        trigger: custom.length > 0 ? "manual" : "auto",
        custom_instructions: custom,
      }
      const result = await dispatchEvent(pi, loaded, history, options, "PreCompact", null, payload)
      if (result.blocked) {
        if (ctx.hasUI) ctx.ui.notify("Compaction cancelled by PreCompact hook: " + result.reason, "warning")
        return { cancel: true }
      }
      return undefined
    } catch {
      return undefined
    }
  })

  pi.on("session_shutdown", async (event: { reason?: unknown }, ctx: ExtensionContext) => {
    try {
      if (hasHooks("SessionEnd")) {
        const payload = {
          ...basePayload(ctx, "SessionEnd"),
          reason: typeof event.reason === "string" ? event.reason : "exit",
        }
        await dispatchEvent(pi, loaded, history, options, "SessionEnd", null, payload)
      }
    } catch {
      return
    } finally {
      manager.stop()
    }
  })

  pi.registerCommand("hooks", {
    description: "Show hooks, monitors, problems, and recent dispatches: /hooks [reload]",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const arg = (args ?? "").trim().toLowerCase()
      if (arg === "reload") {
        loaded = loadHooks(ctx.cwd, config.defaultTimeoutMs)
        if (!ctx.hasUI) return
        const summary =
          "hooks reloaded: " +
          loaded.totalHooks +
          " hook(s) from " +
          loaded.sources.length +
          " file(s)" +
          (loaded.problems.length > 0 ? ", " + loaded.problems.length + " problem(s)" : "")
        ctx.ui.notify(summary, loaded.problems.length > 0 ? "warning" : "info")
        return
      }
      if (arg !== "") {
        if (ctx.hasUI) ctx.ui.notify("usage: /hooks [reload]", "warning")
        return
      }
      if (!ctx.hasUI) return
      const report = buildReport(loaded, manager.statuses(), history, config, ctx.cwd)
      ctx.ui.notify(report.text, report.hasProblems ? "warning" : "info")
    },
    getArgumentCompletions: (argument: string) => {
      const prefix = (argument ?? "").trim().toLowerCase()
      return "reload".startsWith(prefix) ? [{ value: "reload", label: "reload" }] : null
    },
  })
}
