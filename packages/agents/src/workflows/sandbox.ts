import { createContext, Script } from "node:vm"

export const SYNC_TIMEOUT_MS = 30000
export const SCRIPT_FILENAME = "workflow.js"

export interface WorkflowBudget {
  total: number | null
  spent: () => number
  remaining: () => number
}

export interface ScriptGlobals {
  agent: (prompt: unknown, opts?: unknown) => Promise<unknown>
  parallel: (thunks: unknown) => Promise<unknown[]>
  pipeline: (items: unknown, ...stages: unknown[]) => Promise<unknown[]>
  phase: (title: unknown) => void
  log: (message: unknown) => void
  args: unknown
  budget: WorkflowBudget
}

export interface SandboxRun {
  body: string
  globals: ScriptGlobals
  controller: AbortController
  timeoutMs: number
}

export class ScriptGlobalsBuilder {
  build(globals: ScriptGlobals, signal: AbortSignal, timers: Set<ReturnType<typeof setTimeout>>): Record<string, unknown> {
    const emit = (prefix: string) => (...parts: unknown[]): void => {
      const text = parts.map(ScriptGlobalsBuilder.renderPart).join(" ")
      globals.log(prefix === "" ? text : `${prefix} ${text}`)
    }
    const safeSetTimeout = (handler: unknown, delay?: unknown): ReturnType<typeof setTimeout> => {
      if (typeof handler !== "function") {
        throw new TypeError("workflow: setTimeout requires a function")
      }

      const ms = typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? delay : 0
      const handle = setTimeout(() => {
        timers.delete(handle)

        if (signal.aborted) {
          return
        }

        try {
          ;(handler as () => void)()
        } catch (error) {
          globals.log(`[error] timer callback failed: ${ScriptGlobalsBuilder.describeError(error)}`)
        }
      }, ms)

      timers.add(handle)

      return handle
    }
    const safeClearTimeout = (handle: unknown): void => {
      const known = handle as ReturnType<typeof setTimeout>

      if (timers.has(known)) {
        timers.delete(known)
        clearTimeout(known)
      }
    }

    return {
      agent: globals.agent,
      parallel: globals.parallel,
      pipeline: globals.pipeline,
      phase: globals.phase,
      log: (message: unknown): void => globals.log(message),
      args: globals.args,
      budget: globals.budget,
      JSON,
      Math: ScriptGlobalsBuilder.blockedMath(),
      Date: ScriptGlobalsBuilder.blockedDate(),
      Object,
      Array,
      String,
      Number,
      Boolean,
      Promise,
      Set,
      Map,
      RegExp,
      Error,
      structuredClone,
      setTimeout: safeSetTimeout,
      clearTimeout: safeClearTimeout,
      console: {
        log: emit(""),
        info: emit(""),
        debug: emit(""),
        warn: emit("[warn]"),
        error: emit("[error]")
      }
    }
  }

  static blockedMath(): Record<string, unknown> {
    const copy: Record<string, unknown> = {}
    const source = Math as unknown as Record<string, unknown>

    for (const key of Object.getOwnPropertyNames(Math)) {
      copy[key] = source[key]
    }

    copy.random = (): never => {
      throw new Error("workflow: Math.random() is blocked in workflow scripts; vary prompts by item index instead")
    }

    return copy
  }

  static blockedDate(): DateConstructor {
    return new Proxy(Date, {
      construct(target, argumentsList: unknown[]): object {
        if (argumentsList.length === 0) {
          throw new Error("workflow: new Date() with no arguments is blocked in workflow scripts; pass timestamps in through args")
        }

        return Reflect.construct(target, argumentsList) as object
      },
      apply(): never {
        throw new Error("workflow: Date() is blocked in workflow scripts; pass timestamps in through args")
      },
      get(target, property, receiver): unknown {
        if (property === "now") {
          return (): never => {
            throw new Error("workflow: Date.now() is blocked in workflow scripts; pass timestamps in through args")
          }
        }

        return Reflect.get(target, property, receiver) as unknown
      }
    })
  }

  static renderPart(part: unknown): string {
    if (typeof part === "string") {
      return part
    }

    try {
      return JSON.stringify(part) ?? String(part)
    } catch {
      return String(part)
    }
  }

  static describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

export class Sandbox {
  private readonly builder = new ScriptGlobalsBuilder()

  async execute(run: SandboxRun): Promise<unknown> {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const sandbox = this.builder.build(run.globals, run.controller.signal, timers)
    const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
    const script = new Script(`(async () => {\n${run.body}\n})()`, { filename: SCRIPT_FILENAME })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      run.controller.abort()
    }, run.timeoutMs)
    let onAbort: (() => void) | undefined

    try {
      const value = script.runInContext(context, { timeout: SYNC_TIMEOUT_MS }) as unknown
      const settled = Promise.resolve(value)
      void settled.catch(() => undefined)
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = (): void => {
          if (timedOut) {
            const seconds = Math.max(1, Math.round(run.timeoutMs / 1000))
            reject(new Error(`workflow: the run exceeded the ${seconds}s wall-clock limit (workflows.timeoutSec) and was aborted`))

            return
          }

          const reason: unknown = run.controller.signal.reason
          reject(reason instanceof Error && reason.name !== "AbortError" ? reason : new Error("workflow: run aborted"))
        }

        if (run.controller.signal.aborted) {
          onAbort()
        } else {
          run.controller.signal.addEventListener("abort", onAbort, { once: true })
        }
      })

      return await Promise.race([settled, aborted])
    } finally {
      clearTimeout(timer)

      for (const handle of timers) {
        clearTimeout(handle)
      }

      if (onAbort) {
        run.controller.signal.removeEventListener("abort", onAbort)
      }
    }
  }

  static renderPart(part: unknown): string {
    return ScriptGlobalsBuilder.renderPart(part)
  }
}
