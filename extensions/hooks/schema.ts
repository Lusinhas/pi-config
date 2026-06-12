import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "PreCompact",
  "SessionEnd",
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]

export const EVENT_MAPPING: Record<HookEventName, string> = {
  PreToolUse: "tool_call",
  PostToolUse: "tool_result",
  UserPromptSubmit: "input",
  SessionStart: "session_start",
  Stop: "agent_end",
  PreCompact: "session_before_compact",
  SessionEnd: "session_shutdown",
}

export interface HookCommand {
  command: string
  timeoutMs: number
  source: string
}

export interface HookGroup {
  matcher: RegExp | null
  matcherSource: string
  hooks: HookCommand[]
  source: string
}

export interface LoadedHooks {
  events: Record<HookEventName, HookGroup[]>
  problems: string[]
  sources: string[]
  totalHooks: number
}

const eventNames = new Set<string>(HOOK_EVENTS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isEventName(value: string): value is HookEventName {
  return eventNames.has(value)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function emptyEvents(): Record<HookEventName, HookGroup[]> {
  return {
    PreToolUse: [],
    PostToolUse: [],
    UserPromptSubmit: [],
    SessionStart: [],
    Stop: [],
    PreCompact: [],
    SessionEnd: [],
  }
}

function parseGroup(
  entry: unknown,
  label: string,
  source: string,
  defaultTimeoutMs: number,
  problems: string[],
): HookGroup | null {
  if (!isRecord(entry)) {
    problems.push(label + ": matcher group must be an object")
    return null
  }
  let matcher: RegExp | null = null
  let matcherSource = ""
  if (entry.matcher !== undefined && entry.matcher !== null) {
    if (typeof entry.matcher !== "string") {
      problems.push(label + ": matcher must be a string")
      return null
    }
    matcherSource = entry.matcher
    if (matcherSource.length > 0 && matcherSource !== "*") {
      try {
        matcher = new RegExp(matcherSource)
      } catch (err) {
        problems.push(label + ': invalid matcher regex "' + matcherSource + '" (' + message(err) + ")")
        return null
      }
    }
  }
  if (!Array.isArray(entry.hooks)) {
    problems.push(label + ": hooks must be an array")
    return null
  }
  const hooks: HookCommand[] = []
  entry.hooks.forEach((hook, index) => {
    const hookLabel = label + ".hooks[" + index + "]"
    if (!isRecord(hook)) {
      problems.push(hookLabel + ": hook must be an object")
      return
    }
    if (hook.type !== "command") {
      problems.push(hookLabel + ': type must be "command"')
      return
    }
    const command = typeof hook.command === "string" ? hook.command.trim() : ""
    if (command.length === 0) {
      problems.push(hookLabel + ": command must be a non-empty string")
      return
    }
    let timeoutMs = defaultTimeoutMs
    if (hook.timeout !== undefined) {
      if (typeof hook.timeout === "number" && Number.isFinite(hook.timeout) && hook.timeout > 0) {
        timeoutMs = Math.round(hook.timeout * 1000)
      } else {
        problems.push(hookLabel + ": timeout must be a positive number of seconds; using the default")
      }
    }
    hooks.push({ command, timeoutMs, source })
  })
  if (hooks.length === 0) return null
  return { matcher, matcherSource, hooks, source }
}

function mergeFile(loaded: LoadedHooks, parsed: unknown, path: string, defaultTimeoutMs: number): void {
  if (!isRecord(parsed)) {
    loaded.problems.push(path + ": top level must be a JSON object")
    return
  }
  let map: Record<string, unknown>
  if (isRecord(parsed.hooks)) {
    map = parsed.hooks
  } else if (parsed.hooks === undefined && Object.keys(parsed).some((key) => isEventName(key))) {
    map = parsed
  } else {
    loaded.problems.push(path + ': missing "hooks" object')
    return
  }
  for (const [eventName, value] of Object.entries(map)) {
    if (!isEventName(eventName)) {
      loaded.problems.push(
        path + ': unsupported event "' + eventName + '" (supported: ' + HOOK_EVENTS.join(", ") + ")",
      )
      continue
    }
    if (!Array.isArray(value)) {
      loaded.problems.push(path + ": " + eventName + " must be an array of matcher groups")
      continue
    }
    value.forEach((entry, index) => {
      const label = path + " " + eventName + "[" + index + "]"
      const group = parseGroup(entry, label, path, defaultTimeoutMs, loaded.problems)
      if (group !== null) {
        loaded.events[eventName].push(group)
        loaded.totalHooks += group.hooks.length
      }
    })
  }
}

export function hookConfigPaths(cwd: string): string[] {
  return [join(homedir(), ".pi", "agent", "hooks.json"), join(cwd, ".pi", "hooks.json")]
}

export function loadHooks(cwd: string, defaultTimeoutMs: number): LoadedHooks {
  const loaded: LoadedHooks = { events: emptyEvents(), problems: [], sources: [], totalHooks: 0 }
  for (const path of hookConfigPaths(cwd)) {
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      loaded.problems.push(path + ": invalid JSON (" + message(err) + ")")
      continue
    }
    loaded.sources.push(path)
    mergeFile(loaded, parsed, path, defaultTimeoutMs)
  }
  return loaded
}
