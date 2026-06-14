import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export interface AgentDefinition {
  name: string
  description: string
  model: string
  tools: "all" | string[]
  thinking: ThinkingLevel | ""
  prompt: string
  source: string
}

export interface AgentParseError {
  source: string
  reason: string
}

export interface AgentRegistry {
  agents: Map<string, AgentDefinition>
  errors: AgentParseError[]
  paths: string[]
}

export interface ParsedDocument {
  fields: Record<string, string>
  body: string
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/

export class PackageAgentManifest {
  static readonly entries = [
    "advisory/oracle.md",
    "build/coder.md",
    "build/tester.md",
    "planning/architect.md",
    "planning/critic.md",
    "research/explorer.md",
    "research/librarian.md",
    "review/reviewer.md",
    "review/security.md",
    "security/attacksurface.md",
    "security/pentestrunner.md",
    "security/reporter.md",
    "security/vulntracer.md"
  ] as const

  files(): string[] {
    return PackageAgentManifest.entries.map((entry) => fileURLToPath(new URL(`../../../../agents/${entry}`, import.meta.url)))
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class QuoteStripper {
  strip(value: string): string {
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]

      if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
        return value.slice(1, -1)
      }
    }

    return value
  }
}

const quoteStripper = new QuoteStripper()

export function stripQuotes(value: string): string {
  return quoteStripper.strip(value)
}

export function parseDocument(text: string): ParsedDocument | string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  let start = 0

  while (start < lines.length && lines[start].trim() === "") {
    start += 1
  }

  if (start >= lines.length || lines[start].trim() !== "---") {
    return "missing frontmatter opening ---"
  }

  let end = -1

  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i
      break
    }
  }

  if (end === -1) {
    return "missing frontmatter closing ---"
  }

  const fields: Record<string, string> = {}

  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i]

    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue
    }

    const separator = line.indexOf(":")

    if (separator === -1) {
      return `invalid frontmatter line ${i + 1}: "${line.trim()}"`
    }

    const key = line.slice(0, separator).trim().toLowerCase()

    if (key === "") {
      return `invalid frontmatter line ${i + 1}: empty key`
    }

    fields[key] = stripQuotes(line.slice(separator + 1).trim())
  }

  return { fields, body: lines.slice(end + 1).join("\n").trim() }
}

export class AgentDocumentParser {
  parse(source: string, text: string): { definition?: AgentDefinition; error?: AgentParseError } {
    const parsed = parseDocument(text)

    if (typeof parsed === "string") {
      return { error: { source, reason: parsed } }
    }

    const { fields, body } = parsed
    const name = (fields.name ?? "").trim()

    if (name === "") {
      return { error: { source, reason: "frontmatter is missing required key: name" } }
    }

    if (!NAME_PATTERN.test(name)) {
      return { error: { source, reason: `agent name "${name}" must be a single word of letters, digits, hyphens, or underscores` } }
    }

    const description = (fields.description ?? "").trim()

    if (description === "") {
      return { error: { source, reason: "frontmatter is missing required key: description" } }
    }

    const model = (fields.model ?? "inherit").trim() || "inherit"
    const toolsRaw = (fields.tools ?? "all").trim()
    let tools: "all" | string[]

    if (toolsRaw === "" || toolsRaw.toLowerCase() === "all") {
      tools = "all"
    } else {
      const names = [...new Set(toolsRaw.split(/[\s,]+/).filter((item) => item.length > 0))]
      tools = names.length > 0 ? names : "all"
    }

    const thinkingRaw = (fields.thinking ?? "").trim().toLowerCase()

    if (thinkingRaw !== "" && !(THINKING_LEVELS as readonly string[]).includes(thinkingRaw)) {
      return { error: { source, reason: `invalid thinking level "${thinkingRaw}" (expected one of: ${THINKING_LEVELS.join(", ")})` } }
    }

    if (body === "") {
      return { error: { source, reason: "agent body (system prompt) is empty" } }
    }

    return {
      definition: {
        name,
        description,
        model,
        tools,
        thinking: thinkingRaw as ThinkingLevel | "",
        prompt: body,
        source
      }
    }
  }
}

const documentParser = new AgentDocumentParser()

export function parseAgentFile(source: string, text: string): { definition?: AgentDefinition; error?: AgentParseError } {
  return documentParser.parse(source, text)
}

export class RegistryLoader {
  private readonly shippedPaths: string[]
  private readonly parser: AgentDocumentParser

  constructor(shippedPaths: string[], parser = documentParser) {
    this.shippedPaths = [...shippedPaths]
    this.parser = parser
  }

  load(_cwd: string): AgentRegistry {
    const agents = new Map<string, AgentDefinition>()
    const errors: AgentParseError[] = []

    for (const file of this.shippedPaths) {
      let text: string

      try {
        text = readFileSync(file, "utf8")
      } catch (error) {
        errors.push({ source: file, reason: `unreadable: ${describeError(error)}` })
        continue
      }

      const { definition, error } = this.parser.parse(file, text)

      if (error) {
        errors.push(error)
      }

      if (definition) {
        agents.set(definition.name, definition)
      }
    }

    return { agents, errors, paths: [...this.shippedPaths] }
  }
}

export function loadRegistry(_cwd: string): AgentRegistry {
  return new RegistryLoader(new PackageAgentManifest().files()).load(_cwd)
}
