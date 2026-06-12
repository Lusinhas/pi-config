import { createContext, runInNewContext, Script } from "node:vm"

const SCRIPT_BYTES = 524288
const SYNC_TIMEOUT_MS = 30000
const META_TIMEOUT_MS = 1000

export interface MetaPhase {
  title: string
  detail: string
  model: string
}

export interface WorkflowMeta {
  name: string
  description: string
  title: string
  whenToUse: string
  phases: MetaPhase[]
}

export interface ParsedScript {
  meta: WorkflowMeta
  body: string
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function skipTrivia(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    const ch = text[i]
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    break
  }
  return i
}

function skipString(text: string, from: number): number {
  const quote = text[from]
  let i = from + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    i += 1
  }
  return text.length
}

function literalEnd(text: string, from: number): number {
  let depth = 0
  let i = from
  while (i < text.length) {
    const ch = text[i]
    if (ch === "\"" || ch === "'" || ch === "`") {
      i = skipString(text, i)
      continue
    }
    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      i = skipTrivia(text, i)
      continue
    }
    if (ch === "{" || ch === "[") {
      depth += 1
    } else if (ch === "}" || ch === "]") {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

function normalizeMeta(raw: unknown): WorkflowMeta {
  if (!isRecord(raw)) throw new Error("workflow: meta must be an object literal")
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (name === "") throw new Error("workflow: meta.name must be a non-empty string")
  const description = typeof raw.description === "string" ? raw.description.trim() : ""
  if (description === "") throw new Error("workflow: meta.description must be a non-empty string")
  const phases: MetaPhase[] = []
  if (Array.isArray(raw.phases)) {
    for (const entry of raw.phases) {
      if (!isRecord(entry) || typeof entry.title !== "string" || entry.title.trim() === "") continue
      phases.push({
        title: entry.title.trim(),
        detail: typeof entry.detail === "string" ? entry.detail : "",
        model: typeof entry.model === "string" ? entry.model : ""
      })
    }
  }
  return {
    name,
    description,
    title: typeof raw.title === "string" ? raw.title : "",
    whenToUse: typeof raw.whenToUse === "string" ? raw.whenToUse : "",
    phases
  }
}

export function parseScript(script: string): ParsedScript {
  if (typeof script !== "string" || script.trim() === "") throw new Error("workflow: the script is empty")
  if (Buffer.byteLength(script, "utf8") > SCRIPT_BYTES) {
    throw new Error(`workflow: the script exceeds the ${SCRIPT_BYTES}-byte limit`)
  }
  const start = skipTrivia(script, 0)
  const head = /^(?:export\s+)?const\s+meta\s*=\s*/.exec(script.slice(start))
  if (!head) {
    throw new Error("workflow: `export const meta = { name, description, phases }` must be the first statement in the script")
  }
  const braceStart = start + head[0].length
  if (script[braceStart] !== "{") throw new Error("workflow: meta must be an object literal")
  const braceEnd = literalEnd(script, braceStart)
  if (braceEnd === -1) throw new Error("workflow: the meta object literal is never closed")
  const metaSource = script.slice(braceStart, braceEnd + 1)
  let raw: unknown
  try {
    raw = runInNewContext(`(${metaSource})`, {}, {
      timeout: META_TIMEOUT_MS,
      filename: "workflow-meta.js",
      contextCodeGeneration: { strings: false, wasm: false }
    }) as unknown
  } catch (error) {
    throw new Error(`workflow: meta must be a pure literal object: ${describeError(error)}`)
  }
  const meta = normalizeMeta(raw)
  const body = script.slice(0, start) + script.slice(start).replace(/^export\s+/, "")
  return { meta, body }
}

function renderPart(part: unknown): string {
  if (typeof part === "string") return part
  try {
    return JSON.stringify(part) ?? String(part)
  } catch {
    return String(part)
  }
}

function blockedMath(): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  const source = Math as unknown as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(Math)) copy[key] = source[key]
  copy.random = (): never => {
    throw new Error("workflow: Math.random() is blocked in workflow scripts; vary prompts by item index instead")
  }
  return copy
}

function blockedDate(): DateConstructor {
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

function buildSandbox(globals: ScriptGlobals, signal: AbortSignal, timers: Set<ReturnType<typeof setTimeout>>): Record<string, unknown> {
  const emit = (prefix: string) => (...parts: unknown[]): void => {
    const text = parts.map(renderPart).join(" ")
    globals.log(prefix === "" ? text : `${prefix} ${text}`)
  }
  const safeSetTimeout = (handler: unknown, delay?: unknown): ReturnType<typeof setTimeout> => {
    if (typeof handler !== "function") throw new TypeError("workflow: setTimeout requires a function")
    const ms = typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? delay : 0
    const handle = setTimeout(() => {
      timers.delete(handle)
      if (signal.aborted) return
      try {
        (handler as () => void)()
      } catch (error) {
        globals.log(`[error] timer callback failed: ${describeError(error)}`)
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
    Math: blockedMath(),
    Date: blockedDate(),
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

export async function executeScript(run: SandboxRun): Promise<unknown> {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const sandbox = buildSandbox(run.globals, run.controller.signal, timers)
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
  const script = new Script(`(async () => {\n${run.body}\n})()`, { filename: "workflow.js" })
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
      if (run.controller.signal.aborted) onAbort()
      else run.controller.signal.addEventListener("abort", onAbort, { once: true })
    })
    return await Promise.race([settled, aborted])
  } finally {
    clearTimeout(timer)
    for (const handle of timers) clearTimeout(handle)
    if (onAbort) run.controller.signal.removeEventListener("abort", onAbort)
  }
}
