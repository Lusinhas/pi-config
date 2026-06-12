import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export interface MonitorSpec {
  name: string
  command: string
  when: "always"
}

export interface MonitorOptions {
  specs: MonitorSpec[]
  backoffInitialMs: number
  backoffMaxMs: number
  backoffResetAfterMs: number
  killGraceMs: number
  maxLineLength: number
}

export interface MonitorStatus {
  name: string
  command: string
  state: string
  pid: number | null
  restarts: number
  lastExit: string
  stderrTail: string
}

export interface MonitorManager {
  start(cwd: string): void
  stop(): void
  statuses(): MonitorStatus[]
}

interface Runner {
  spec: MonitorSpec
  child: ChildProcess | null
  timer: ReturnType<typeof setTimeout> | null
  delayMs: number
  restarts: number
  state: string
  lastExit: string
  stderrTail: string
  buffer: string
  startedAt: number
  scheduled: boolean
}

export function createMonitorManager(pi: ExtensionAPI, options: MonitorOptions): MonitorManager {
  const backoffMaxMs = Math.max(options.backoffInitialMs, options.backoffMaxMs)
  const runners: Runner[] = options.specs.map((spec) => ({
    spec,
    child: null,
    timer: null,
    delayMs: options.backoffInitialMs,
    restarts: 0,
    state: "stopped",
    lastExit: "",
    stderrTail: "",
    buffer: "",
    startedAt: 0,
    scheduled: false,
  }))
  let active = false
  let cwd = process.cwd()

  function forward(runner: Runner, line: string): void {
    const cleaned = line.endsWith("\r") ? line.slice(0, -1) : line
    if (cleaned.trim().length === 0) return
    const text =
      cleaned.length > options.maxLineLength ? cleaned.slice(0, options.maxLineLength) + " [truncated]" : cleaned
    try {
      pi.sendMessage(
        { customType: "monitor", content: "[monitor:" + runner.spec.name + "] " + text, display: false },
        { deliverAs: "nextTurn" },
      )
    } catch {
      return
    }
  }

  function drain(runner: Runner, chunk: string): void {
    runner.buffer += chunk
    let index = runner.buffer.indexOf("\n")
    while (index !== -1) {
      const line = runner.buffer.slice(0, index)
      runner.buffer = runner.buffer.slice(index + 1)
      forward(runner, line)
      index = runner.buffer.indexOf("\n")
    }
    if (runner.buffer.length > options.maxLineLength * 4) {
      const oversized = runner.buffer
      runner.buffer = ""
      forward(runner, oversized)
    }
  }

  function flush(runner: Runner): void {
    if (runner.buffer.length === 0) return
    const rest = runner.buffer
    runner.buffer = ""
    forward(runner, rest)
  }

  function schedule(runner: Runner): void {
    if (!active || runner.scheduled) return
    runner.scheduled = true
    runner.state = "restarting"
    runner.restarts += 1
    if (runner.startedAt > 0 && Date.now() - runner.startedAt >= options.backoffResetAfterMs) {
      runner.delayMs = options.backoffInitialMs
    }
    const delay = runner.delayMs
    runner.delayMs = Math.min(runner.delayMs * 2, backoffMaxMs)
    const timer = setTimeout(() => {
      runner.timer = null
      runner.scheduled = false
      if (active) launch(runner)
    }, delay)
    if (typeof timer.unref === "function") timer.unref()
    runner.timer = timer
  }

  function launch(runner: Runner): void {
    if (!active || runner.child !== null) return
    let child: ChildProcess
    try {
      child = spawn(runner.spec.command, {
        shell: true,
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      runner.lastExit = "spawn failed: " + (err instanceof Error ? err.message : String(err))
      runner.state = "failed"
      schedule(runner)
      return
    }
    runner.child = child
    runner.startedAt = Date.now()
    runner.state = "running"
    runner.buffer = ""
    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => drain(runner, chunk))
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => {
        runner.stderrTail = (runner.stderrTail + chunk).slice(-400)
      })
    }
    child.on("error", (err: Error) => {
      if (runner.child !== child) return
      runner.child = null
      runner.lastExit = "error: " + err.message
      flush(runner)
      if (active) schedule(runner)
      else runner.state = "stopped"
    })
    child.on("exit", (code: number | null, signalName: string | null) => {
      if (runner.child !== child) return
      runner.child = null
      runner.lastExit = signalName !== null ? "signal " + signalName : "code " + String(code)
      flush(runner)
      if (active) schedule(runner)
      else runner.state = "stopped"
    })
  }

  function start(startCwd: string): void {
    if (startCwd.length > 0) cwd = startCwd
    if (active) return
    active = true
    for (const runner of runners) {
      runner.delayMs = options.backoffInitialMs
      runner.scheduled = false
      runner.restarts = 0
      runner.startedAt = 0
      launch(runner)
    }
  }

  function stop(): void {
    active = false
    for (const runner of runners) {
      if (runner.timer !== null) {
        clearTimeout(runner.timer)
        runner.timer = null
      }
      runner.scheduled = false
      const child = runner.child
      if (child === null) {
        runner.state = "stopped"
        continue
      }
      runner.state = "stopping"
      try {
        child.kill("SIGTERM")
      } catch {
        runner.child = null
        runner.state = "stopped"
        continue
      }
      const killer = setTimeout(() => {
        if (runner.child !== child) return
        try {
          child.kill("SIGKILL")
        } catch {
          return
        }
      }, options.killGraceMs)
      if (typeof killer.unref === "function") killer.unref()
    }
  }

  function statuses(): MonitorStatus[] {
    return runners.map((runner) => ({
      name: runner.spec.name,
      command: runner.spec.command,
      state: runner.state,
      pid: runner.child !== null && typeof runner.child.pid === "number" ? runner.child.pid : null,
      restarts: runner.restarts,
      lastExit: runner.lastExit,
      stderrTail: runner.stderrTail.replace(/\s+/g, " ").trim().slice(-160),
    }))
  }

  return { start, stop, statuses }
}
