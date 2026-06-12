import { randomBytes } from "node:crypto"
import { unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { HookCommand, HookEventName, LoadedHooks } from "./schema"

export interface DispatchOptions {
  shell: string
  eventBudgetMs: number
  maxOutputBytes: number
}

export type DispatchOutcome = "ok" | "context" | "approve" | "block" | "error" | "timeout" | "skipped"

export interface DispatchRecord {
  at: string
  event: HookEventName
  command: string
  outcome: DispatchOutcome
  exitCode: number | null
  durationMs: number
  detail: string
}

export interface History {
  push(record: DispatchRecord): void
  list(): DispatchRecord[]
}

export interface EventOutcome {
  blocked: boolean
  reason: string
  approved: boolean
  context: string[]
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  killed: boolean
}

interface Decision {
  decision: "block" | "approve"
  reason: string
}

export function createHistory(size: number): History {
  const cap = size > 0 ? size : 1
  const records: DispatchRecord[] = []
  return {
    push(record: DispatchRecord): void {
      records.push(record)
      if (records.length > cap) records.splice(0, records.length - cap)
    },
    list(): DispatchRecord[] {
      return [...records]
    },
  }
}

function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'"
}

function clip(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text
  return text.slice(0, maxBytes) + "\n[truncated]"
}

function shortCommand(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim()
  return flat.length > 80 ? flat.slice(0, 77) + "..." : flat
}

function makeRecord(
  eventName: HookEventName,
  hook: HookCommand,
  outcome: DispatchOutcome,
  exitCode: number | null,
  durationMs: number,
  detail: string,
): DispatchRecord {
  return {
    at: new Date().toISOString(),
    event: eventName,
    command: shortCommand(hook.command),
    outcome,
    exitCode,
    durationMs,
    detail: detail.replace(/\s+/g, " ").trim().slice(0, 160),
  }
}

function sanitize(value: unknown, ancestors: object[]): unknown {
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function" || typeof value === "symbol") return undefined
  if (typeof value !== "object" || value === null) return value
  if (ancestors.includes(value)) return "[circular]"
  ancestors.push(value)
  let result: unknown
  if (Array.isArray(value)) {
    result = value.map((item) => {
      const cleaned = sanitize(item, ancestors)
      return cleaned === undefined ? null : cleaned
    })
  } else {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = sanitize(entry, ancestors)
      if (cleaned !== undefined) out[key] = cleaned
    }
    result = out
  }
  ancestors.pop()
  return result
}

export function basePayload(ctx: ExtensionContext, eventName: HookEventName): Record<string, unknown> {
  let sessionFile = ""
  try {
    const file = ctx.sessionManager.getSessionFile()
    if (typeof file === "string") sessionFile = file
  } catch {
    sessionFile = ""
  }
  return {
    session_id: sessionFile.length > 0 ? sessionFile : "unknown",
    transcript_path: sessionFile.length > 0 ? sessionFile : "unknown",
    cwd: ctx.cwd,
    hook_event_name: eventName,
  }
}

function parseDecision(stdout: string): Decision | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith("{")) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.decision !== "block" && record.decision !== "approve") return null
  return { decision: record.decision, reason: typeof record.reason === "string" ? record.reason : "" }
}

function normalizeResult(raw: unknown): ExecResult {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    code: typeof record.code === "number" && Number.isFinite(record.code) ? record.code : null,
    killed: record.killed === true,
  }
}

async function execHook(
  pi: ExtensionAPI,
  shell: string,
  hook: HookCommand,
  payloadJson: string,
  timeoutMs: number,
): Promise<{ result: ExecResult } | { error: string }> {
  const file = join(tmpdir(), "pihook" + randomBytes(9).toString("hex") + ".json")
  let wrote = false
  try {
    writeFileSync(file, payloadJson, { mode: 0o600 })
    wrote = true
    const script = "exec <" + shellQuote(file) + "\n" + hook.command
    const raw = await pi.exec(shell, ["-c", script], { timeout: timeoutMs })
    return { result: normalizeResult(raw) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (wrote) {
      try {
        unlinkSync(file)
      } catch {
        wrote = false
      }
    }
  }
}

export async function dispatchEvent(
  pi: ExtensionAPI,
  loaded: LoadedHooks,
  history: History,
  options: DispatchOptions,
  eventName: HookEventName,
  toolName: string | null,
  payload: Record<string, unknown>,
): Promise<EventOutcome> {
  const outcome: EventOutcome = { blocked: false, reason: "", approved: false, context: [] }
  const groups = loaded.events[eventName]
  if (groups.length === 0) return outcome
  const target = toolName ?? ""
  const matched: HookCommand[] = []
  for (const group of groups) {
    if (group.matcher === null || group.matcher.test(target)) matched.push(...group.hooks)
  }
  if (matched.length === 0) return outcome
  let payloadJson: string
  try {
    payloadJson = JSON.stringify(sanitize(payload, []) ?? {})
  } catch (err) {
    history.push(
      makeRecord(eventName, matched[0], "error", null, 0, "payload serialization failed: " + String(err)),
    )
    return outcome
  }
  const started = Date.now()
  for (const hook of matched) {
    const remaining = options.eventBudgetMs - (Date.now() - started)
    if (remaining <= 0) {
      history.push(
        makeRecord(eventName, hook, "skipped", null, 0, "event budget of " + options.eventBudgetMs + "ms exhausted"),
      )
      continue
    }
    const timeoutMs = Math.min(hook.timeoutMs, remaining)
    const runStart = Date.now()
    const run = await execHook(pi, options.shell, hook, payloadJson, timeoutMs)
    const durationMs = Date.now() - runStart
    if ("error" in run) {
      history.push(makeRecord(eventName, hook, "error", null, durationMs, run.error))
      continue
    }
    const result = run.result
    const stdout = clip(result.stdout, options.maxOutputBytes)
    const stderr = clip(result.stderr, options.maxOutputBytes)
    if (result.killed) {
      history.push(makeRecord(eventName, hook, "timeout", result.code, durationMs, "killed after " + timeoutMs + "ms"))
      continue
    }
    if (result.code === 2) {
      const reason = stderr.trim()
      outcome.blocked = true
      outcome.reason = reason.length > 0 ? reason : "blocked by " + eventName + " hook"
      history.push(makeRecord(eventName, hook, "block", 2, durationMs, outcome.reason))
      break
    }
    if (result.code !== 0) {
      const detail = stderr.trim().length > 0 ? stderr.trim() : "exit code " + String(result.code)
      history.push(makeRecord(eventName, hook, "error", result.code, durationMs, detail))
      continue
    }
    if (eventName === "PreToolUse") {
      const decision = parseDecision(stdout)
      if (decision !== null && decision.decision === "block") {
        outcome.blocked = true
        outcome.reason = decision.reason.length > 0 ? decision.reason : "blocked by PreToolUse hook decision"
        history.push(makeRecord(eventName, hook, "block", 0, durationMs, outcome.reason))
        break
      }
      if (decision !== null) {
        outcome.approved = true
        history.push(makeRecord(eventName, hook, "approve", 0, durationMs, decision.reason))
        continue
      }
    }
    const text = stdout.trim()
    if (text.length > 0) {
      outcome.context.push(text)
      history.push(makeRecord(eventName, hook, "context", 0, durationMs, text))
    } else {
      history.push(makeRecord(eventName, hook, "ok", 0, durationMs, ""))
    }
  }
  return outcome
}
