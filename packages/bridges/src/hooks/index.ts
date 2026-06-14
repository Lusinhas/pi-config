import { randomBytes } from "node:crypto"
import { unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HookCommand, HookEventName, LoadedHooks } from "./schema.ts"

export interface BackoffConfig {
  initialMs: number
  maxMs: number
  resetAfterMs: number
}

export interface MonitorSpec {
  name: string
  command: string
  when: "always"
}

export interface HooksConfig {
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

export const FALLBACK = {
  shell: "/bin/sh",
  defaultTimeoutMs: 60000,
  eventBudgetMs: 120000,
  maxOutputBytes: 16384,
  historySize: 50,
  monitorMaxLineLength: 2000,
  killGraceMs: 3000,
  backoff: { initialMs: 1000, maxMs: 30000, resetAfterMs: 30000 },
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export class Config {
  deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...base }

    for (const [key, value] of Object.entries(override)) {
      const current = result[key]

      if (isRecord(current) && isRecord(value)) {
        result[key] = this.deepMerge(current, value)
      } else if (value !== undefined) {
        result[key] = value
      }
    }

    return result
  }

  resolve(shipped: Record<string, unknown>, overrides: ReadonlyArray<Record<string, unknown>>): HooksConfig {
    let merged: Record<string, unknown> = { ...shipped }

    for (const override of overrides) {
      merged = this.deepMerge(merged, override)
    }

    return this.normalizeConfig(merged)
  }

  normalizeConfig(merged: Record<string, unknown>): HooksConfig {
    const problems: string[] = []
    const backoff = isRecord(merged.backoff) ? merged.backoff : {}
    const initialMs = this.positive(backoff.initialMs, FALLBACK.backoff.initialMs)

    return {
      shell: this.text(merged.shell, FALLBACK.shell),
      defaultTimeoutMs: this.positive(merged.defaultTimeoutMs, FALLBACK.defaultTimeoutMs),
      eventBudgetMs: this.positive(merged.eventBudgetMs, FALLBACK.eventBudgetMs),
      maxOutputBytes: this.positive(merged.maxOutputBytes, FALLBACK.maxOutputBytes),
      historySize: this.positive(merged.historySize, FALLBACK.historySize),
      monitorMaxLineLength: this.positive(merged.monitorMaxLineLength, FALLBACK.monitorMaxLineLength),
      killGraceMs: this.positive(merged.killGraceMs, FALLBACK.killGraceMs),
      backoff: {
        initialMs,
        maxMs: Math.max(initialMs, this.positive(backoff.maxMs, FALLBACK.backoff.maxMs)),
        resetAfterMs: this.positive(backoff.resetAfterMs, FALLBACK.backoff.resetAfterMs),
      },
      monitors: this.normalizeMonitors(merged.monitors, problems),
      problems,
    }
  }

  text(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback
  }

  positive(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
  }

  normalizeMonitors(value: unknown, problems: string[]): MonitorSpec[] {
    if (value === undefined) {
      return []
    }

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
}

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

export interface EventOutcome {
  blocked: boolean
  reason: string
  approved: boolean
  context: string[]
}

export interface RawExec {
  stdout?: unknown
  stderr?: unknown
  code?: unknown
  killed?: unknown
}

export type ExecRunner = (
  command: string,
  args: string[],
  options: { timeout: number },
) => Promise<RawExec>

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  killed: boolean
}

export interface Decision {
  decision: "block" | "approve"
  reason: string
}

export interface SessionInfo {
  sessionFile: string
  cwd: string
}

export class History {
  private readonly cap: number
  private readonly records: DispatchRecord[] = []

  constructor(size: number) {
    this.cap = size > 0 ? size : 1
  }

  push(record: DispatchRecord): void {
    this.records.push(record)

    if (this.records.length > this.cap) {
      this.records.splice(0, this.records.length - this.cap)
    }
  }

  list(): DispatchRecord[] {
    return [...this.records]
  }
}

export function basePayload(info: SessionInfo, eventName: HookEventName): Record<string, unknown> {
  const sessionFile = info.sessionFile.length > 0 ? info.sessionFile : "unknown"

  return {
    session_id: sessionFile,
    transcript_path: sessionFile,
    cwd: info.cwd,
    hook_event_name: eventName,
  }
}

export class Dispatcher {
  private readonly exec: ExecRunner
  private readonly options: DispatchOptions

  constructor(exec: ExecRunner, options: DispatchOptions) {
    this.exec = exec
    this.options = options
  }

  async dispatch(
    loaded: LoadedHooks,
    history: History,
    eventName: HookEventName,
    toolName: string | null,
    payload: Record<string, unknown>,
  ): Promise<EventOutcome> {
    const outcome: EventOutcome = { blocked: false, reason: "", approved: false, context: [] }
    const groups = loaded.events[eventName]

    if (groups.length === 0) {
      return outcome
    }

    const target = toolName ?? ""
    const matched: HookCommand[] = []

    for (const group of groups) {
      if (group.matcher === null || group.matcher.test(target)) {
        matched.push(...group.hooks)
      }
    }

    if (matched.length === 0) {
      return outcome
    }

    let payloadJson: string

    try {
      payloadJson = JSON.stringify(this.sanitize(payload, []) ?? {})
    } catch (err) {
      history.push(
        this.makeRecord(eventName, matched[0], "error", null, 0, "payload serialization failed: " + String(err)),
      )
      return outcome
    }

    await this.runMatched(matched, history, eventName, payloadJson, outcome)

    return outcome
  }

  private async runMatched(
    matched: HookCommand[],
    history: History,
    eventName: HookEventName,
    payloadJson: string,
    outcome: EventOutcome,
  ): Promise<void> {
    const started = Date.now()

    for (const hook of matched) {
      const remaining = this.options.eventBudgetMs - (Date.now() - started)

      if (remaining <= 0) {
        history.push(
          this.makeRecord(
            eventName,
            hook,
            "skipped",
            null,
            0,
            "event budget of " + this.options.eventBudgetMs + "ms exhausted",
          ),
        )
        continue
      }

      const timeoutMs = Math.min(hook.timeoutMs, remaining)
      const runStart = Date.now()
      const run = await this.runHook(hook, payloadJson, timeoutMs)
      const durationMs = Date.now() - runStart

      if ("error" in run) {
        history.push(this.makeRecord(eventName, hook, "error", null, durationMs, run.error))
        continue
      }

      const result = run.result
      const stdout = this.clip(result.stdout, this.options.maxOutputBytes)
      const stderr = this.clip(result.stderr, this.options.maxOutputBytes)

      if (result.killed) {
        history.push(
          this.makeRecord(eventName, hook, "timeout", result.code, durationMs, "killed after " + timeoutMs + "ms"),
        )
        continue
      }

      if (result.code === 2) {
        const reason = stderr.trim()
        outcome.blocked = true
        outcome.reason = reason.length > 0 ? reason : "blocked by " + eventName + " hook"
        history.push(this.makeRecord(eventName, hook, "block", 2, durationMs, outcome.reason))
        break
      }

      if (result.code !== 0) {
        const detail = stderr.trim().length > 0 ? stderr.trim() : "exit code " + String(result.code)
        history.push(this.makeRecord(eventName, hook, "error", result.code, durationMs, detail))
        continue
      }

      if (eventName === "PreToolUse") {
        const decision = this.parseDecision(stdout)

        if (decision !== null && decision.decision === "block") {
          outcome.blocked = true
          outcome.reason = decision.reason.length > 0 ? decision.reason : "blocked by PreToolUse hook decision"
          history.push(this.makeRecord(eventName, hook, "block", 0, durationMs, outcome.reason))
          break
        }

        if (decision !== null) {
          outcome.approved = true
          history.push(this.makeRecord(eventName, hook, "approve", 0, durationMs, decision.reason))
          continue
        }
      }

      const text = stdout.trim()

      if (text.length > 0) {
        outcome.context.push(text)
        history.push(this.makeRecord(eventName, hook, "context", 0, durationMs, text))
      } else {
        history.push(this.makeRecord(eventName, hook, "ok", 0, durationMs, ""))
      }
    }
  }

  private async runHook(
    hook: HookCommand,
    payloadJson: string,
    timeoutMs: number,
  ): Promise<{ result: ExecResult } | { error: string }> {
    const file = join(tmpdir(), "pihook" + randomBytes(9).toString("hex") + ".json")
    let wrote = false

    try {
      writeFileSync(file, payloadJson, { mode: 0o600 })
      wrote = true
      const script = "exec <" + this.shellQuote(file) + "\n" + hook.command
      const raw = await this.exec(this.options.shell, ["-c", script], { timeout: timeoutMs })
      return { result: this.normalizeResult(raw) }
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

  shellQuote(value: string): string {
    return "'" + value.split("'").join("'\\''") + "'"
  }

  clip(text: string, maxBytes: number): string {
    if (text.length <= maxBytes) {
      return text
    }

    return text.slice(0, maxBytes) + "\n[truncated]"
  }

  shortCommand(command: string): string {
    const flat = command.replace(/\s+/g, " ").trim()
    return flat.length > 80 ? flat.slice(0, 77) + "..." : flat
  }

  makeRecord(
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
      command: this.shortCommand(hook.command),
      outcome,
      exitCode,
      durationMs,
      detail: detail.replace(/\s+/g, " ").trim().slice(0, 160),
    }
  }

  sanitize(value: unknown, ancestors: object[]): unknown {
    if (typeof value === "bigint") {
      return value.toString()
    }

    if (typeof value === "function" || typeof value === "symbol") {
      return undefined
    }

    if (typeof value !== "object" || value === null) {
      return value
    }

    if (ancestors.includes(value)) {
      return "[circular]"
    }

    ancestors.push(value)
    let result: unknown

    if (Array.isArray(value)) {
      result = value.map((item) => {
        const cleaned = this.sanitize(item, ancestors)
        return cleaned === undefined ? null : cleaned
      })
    } else {
      const out: Record<string, unknown> = {}

      for (const [key, entry] of Object.entries(value)) {
        const cleaned = this.sanitize(entry, ancestors)

        if (cleaned !== undefined) {
          out[key] = cleaned
        }
      }

      result = out
    }

    ancestors.pop()
    return result
  }

  parseDecision(stdout: string): Decision | null {
    const trimmed = stdout.trim()

    if (!trimmed.startsWith("{")) {
      return null
    }

    let parsed: unknown

    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null
    }

    const record = parsed as Record<string, unknown>

    if (record.decision !== "block" && record.decision !== "approve") {
      return null
    }

    return { decision: record.decision, reason: typeof record.reason === "string" ? record.reason : "" }
  }

  normalizeResult(raw: unknown): ExecResult {
    const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>

    return {
      stdout: typeof record.stdout === "string" ? record.stdout : "",
      stderr: typeof record.stderr === "string" ? record.stderr : "",
      code: typeof record.code === "number" && Number.isFinite(record.code) ? record.code : null,
      killed: record.killed === true,
    }
  }
}
