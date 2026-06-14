import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import type { MonitorSpec } from "./index.ts"

export interface MonitorOptions {
  specs: MonitorSpec[]
  backoffInitialMs: number
  backoffMaxMs: number
  backoffResetAfterMs: number
  killGraceMs: number
  maxLineLength: number
}

export interface MonitorMessage {
  customType: string
  content: string
  display: boolean
}

export interface MonitorDeliverOptions {
  deliverAs: string
}

export type MonitorEmit = (message: MonitorMessage, options: MonitorDeliverOptions) => void

export interface MonitorStatus {
  name: string
  command: string
  state: string
  pid: number | null
  restarts: number
  lastExit: string
  stderrTail: string
}

const STDERR_TAIL_BYTES = 400

export class Backoff {
  private readonly initialMs: number
  private readonly maxMs: number
  private readonly resetAfterMs: number
  private delayMs: number

  constructor(initialMs: number, maxMs: number, resetAfterMs: number) {
    this.initialMs = initialMs
    this.maxMs = Math.max(initialMs, maxMs)
    this.resetAfterMs = resetAfterMs
    this.delayMs = initialMs
  }

  reset(): void {
    this.delayMs = this.initialMs
  }

  next(startedAt: number, now: number): number {
    if (startedAt > 0 && now - startedAt >= this.resetAfterMs) {
      this.delayMs = this.initialMs
    }

    const delay = this.delayMs
    this.delayMs = Math.min(this.delayMs * 2, this.maxMs)

    return delay
  }
}

export class Runner {
  readonly spec: MonitorSpec
  child: ChildProcess | null = null
  timer: ReturnType<typeof setTimeout> | null = null
  restarts = 0
  state = "stopped"
  lastExit = ""
  stderrTail = ""
  buffer = ""
  startedAt = 0
  scheduled = false

  constructor(spec: MonitorSpec) {
    this.spec = spec
  }
}

export class MonitorManager {
  private readonly emit: MonitorEmit
  private readonly options: MonitorOptions
  private readonly runners: Runner[]
  private readonly backoffs: Map<Runner, Backoff>
  private active = false
  private cwd: string

  constructor(emit: MonitorEmit, options: MonitorOptions, cwd: string) {
    this.emit = emit
    this.options = options
    this.runners = options.specs.map((spec) => new Runner(spec))
    this.backoffs = new Map()

    for (const runner of this.runners) {
      this.backoffs.set(runner, this.makeBackoff())
    }

    this.cwd = cwd
  }

  start(startCwd: string): void {
    if (startCwd.length > 0) {
      this.cwd = startCwd
    }

    if (this.active) {
      return
    }

    this.active = true

    for (const runner of this.runners) {
      this.backoffs.set(runner, this.makeBackoff())
      runner.scheduled = false
      runner.restarts = 0
      runner.startedAt = 0
      this.launch(runner)
    }
  }

  stop(): void {
    this.active = false

    for (const runner of this.runners) {
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
        if (runner.child !== child) {
          return
        }

        try {
          child.kill("SIGKILL")
        } catch {
          return
        }
      }, this.options.killGraceMs)

      if (typeof killer.unref === "function") {
        killer.unref()
      }
    }
  }

  statuses(): MonitorStatus[] {
    return this.runners.map((runner) => ({
      name: runner.spec.name,
      command: runner.spec.command,
      state: runner.state,
      pid: runner.child !== null && typeof runner.child.pid === "number" ? runner.child.pid : null,
      restarts: runner.restarts,
      lastExit: runner.lastExit,
      stderrTail: runner.stderrTail.replace(/\s+/g, " ").trim().slice(-160),
    }))
  }

  private makeBackoff(): Backoff {
    return new Backoff(this.options.backoffInitialMs, this.options.backoffMaxMs, this.options.backoffResetAfterMs)
  }

  private forward(runner: Runner, line: string): void {
    const cleaned = line.endsWith("\r") ? line.slice(0, -1) : line

    if (cleaned.trim().length === 0) {
      return
    }

    const text =
      cleaned.length > this.options.maxLineLength
        ? cleaned.slice(0, this.options.maxLineLength) + " [truncated]"
        : cleaned

    try {
      this.emit(
        { customType: "monitor", content: "[monitor:" + runner.spec.name + "] " + text, display: false },
        { deliverAs: "nextTurn" },
      )
    } catch {
      return
    }
  }

  private drain(runner: Runner, chunk: string): void {
    runner.buffer += chunk
    let index = runner.buffer.indexOf("\n")

    while (index !== -1) {
      const line = runner.buffer.slice(0, index)
      runner.buffer = runner.buffer.slice(index + 1)
      this.forward(runner, line)
      index = runner.buffer.indexOf("\n")
    }

    if (runner.buffer.length > this.options.maxLineLength * 4) {
      const oversized = runner.buffer
      runner.buffer = ""
      this.forward(runner, oversized)
    }
  }

  private flush(runner: Runner): void {
    if (runner.buffer.length === 0) {
      return
    }

    const rest = runner.buffer
    runner.buffer = ""
    this.forward(runner, rest)
  }

  private schedule(runner: Runner): void {
    if (!this.active || runner.scheduled) {
      return
    }

    runner.scheduled = true
    runner.state = "restarting"
    runner.restarts += 1

    const backoff = this.backoffs.get(runner)
    const delay = backoff !== undefined ? backoff.next(runner.startedAt, Date.now()) : this.options.backoffInitialMs

    const timer = setTimeout(() => {
      runner.timer = null
      runner.scheduled = false

      if (this.active) {
        this.launch(runner)
      }
    }, delay)

    if (typeof timer.unref === "function") {
      timer.unref()
    }

    runner.timer = timer
  }

  private launch(runner: Runner): void {
    if (!this.active || runner.child !== null) {
      return
    }

    let child: ChildProcess

    try {
      child = spawn(runner.spec.command, {
        shell: true,
        cwd: this.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      runner.lastExit = "spawn failed: " + (err instanceof Error ? err.message : String(err))
      runner.state = "failed"
      this.schedule(runner)
      return
    }

    runner.child = child
    runner.startedAt = Date.now()
    runner.state = "running"
    runner.buffer = ""

    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => this.drain(runner, chunk))
    }

    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => {
        runner.stderrTail = (runner.stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
      })
    }

    child.on("error", (err: Error) => {
      if (runner.child !== child) {
        return
      }

      runner.child = null
      runner.lastExit = "error: " + err.message
      this.flush(runner)

      if (this.active) {
        this.schedule(runner)
      } else {
        runner.state = "stopped"
      }
    })

    child.on("exit", (code: number | null, signalName: string | null) => {
      if (runner.child !== child) {
        return
      }

      runner.child = null
      runner.lastExit = signalName !== null ? "signal " + signalName : "code " + String(code)
      this.flush(runner)

      if (this.active) {
        this.schedule(runner)
      } else {
        runner.state = "stopped"
      }
    })
  }
}
