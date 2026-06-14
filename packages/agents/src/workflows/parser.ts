import { runInNewContext } from "node:vm"

export const SCRIPT_BYTES = 524288
export const META_TIMEOUT_MS = 1000

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

const META_HEAD = /^(?:export\s+)?const\s+meta\s*=\s*/

export class ScriptParser {
  parse(script: string): ParsedScript {
    if (typeof script !== "string" || script.trim() === "") {
      throw new Error("workflow: the script is empty")
    }

    if (Buffer.byteLength(script, "utf8") > SCRIPT_BYTES) {
      throw new Error(`workflow: the script exceeds the ${SCRIPT_BYTES}-byte limit`)
    }

    const start = ScriptParser.skipTrivia(script, 0)
    const head = META_HEAD.exec(script.slice(start))

    if (!head) {
      throw new Error("workflow: `export const meta = { name, description, phases }` must be the first statement in the script")
    }

    const braceStart = start + head[0].length

    if (script[braceStart] !== "{") {
      throw new Error("workflow: meta must be an object literal")
    }

    const braceEnd = ScriptParser.literalEnd(script, braceStart)

    if (braceEnd === -1) {
      throw new Error("workflow: the meta object literal is never closed")
    }

    const metaSource = script.slice(braceStart, braceEnd + 1)
    const raw = ScriptParser.evaluateMeta(metaSource)
    const meta = ScriptParser.normalizeMeta(raw)
    const body = script.slice(0, start) + script.slice(start).replace(/^export\s+/, "")

    return { meta, body }
  }

  static evaluateMeta(metaSource: string): unknown {
    try {
      return runInNewContext(`(${metaSource})`, {}, {
        timeout: META_TIMEOUT_MS,
        filename: "workflow-meta.js",
        contextCodeGeneration: { strings: false, wasm: false }
      }) as unknown
    } catch (error) {
      throw new Error(`workflow: meta must be a pure literal object: ${ScriptParser.describeError(error)}`)
    }
  }

  static normalizeMeta(raw: unknown): WorkflowMeta {
    if (!ScriptParser.isRecord(raw)) {
      throw new Error("workflow: meta must be an object literal")
    }

    const name = typeof raw.name === "string" ? raw.name.trim() : ""

    if (name === "") {
      throw new Error("workflow: meta.name must be a non-empty string")
    }

    const description = typeof raw.description === "string" ? raw.description.trim() : ""

    if (description === "") {
      throw new Error("workflow: meta.description must be a non-empty string")
    }

    const phases: MetaPhase[] = []

    if (Array.isArray(raw.phases)) {
      for (const entry of raw.phases) {
        if (!ScriptParser.isRecord(entry) || typeof entry.title !== "string" || entry.title.trim() === "") {
          continue
        }

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

  static skipTrivia(text: string, from: number): number {
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

  static skipString(text: string, from: number): number {
    const quote = text[from]
    let i = from + 1

    while (i < text.length) {
      const ch = text[i]

      if (ch === "\\") {
        i += 2
        continue
      }

      if (ch === quote) {
        return i + 1
      }

      i += 1
    }

    return text.length
  }

  static literalEnd(text: string, from: number): number {
    let depth = 0
    let i = from

    while (i < text.length) {
      const ch = text[i]

      if (ch === "\"" || ch === "'" || ch === "`") {
        i = ScriptParser.skipString(text, i)
        continue
      }

      if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
        i = ScriptParser.skipTrivia(text, i)
        continue
      }

      if (ch === "{" || ch === "[") {
        depth += 1
      } else if (ch === "}" || ch === "]") {
        depth -= 1

        if (depth === 0) {
          return i
        }
      }

      i += 1
    }

    return -1
  }

  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  static describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
