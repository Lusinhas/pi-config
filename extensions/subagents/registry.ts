import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
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

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

interface ParsedDocument {
  fields: Record<string, string>
  body: string
}

function parseDocument(text: string): ParsedDocument | string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  let start = 0
  while (start < lines.length && lines[start].trim() === "") start += 1
  if (start >= lines.length || lines[start].trim() !== "---") return "missing frontmatter opening ---"
  let end = -1
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i
      break
    }
  }
  if (end === -1) return "missing frontmatter closing ---"
  const fields: Record<string, string> = {}
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i]
    if (line.trim() === "" || line.trim().startsWith("#")) continue
    const separator = line.indexOf(":")
    if (separator === -1) return `invalid frontmatter line ${i + 1}: "${line.trim()}"`
    const key = line.slice(0, separator).trim().toLowerCase()
    if (key === "") return `invalid frontmatter line ${i + 1}: empty key`
    fields[key] = stripQuotes(line.slice(separator + 1).trim())
  }
  return { fields, body: lines.slice(end + 1).join("\n").trim() }
}

export function parseAgentFile(source: string, text: string): { definition?: AgentDefinition; error?: AgentParseError } {
  const parsed = parseDocument(text)
  if (typeof parsed === "string") return { error: { source, reason: parsed } }
  const { fields, body } = parsed
  const name = (fields.name ?? "").trim()
  if (name === "") return { error: { source, reason: "frontmatter is missing required key: name" } }
  if (!NAME_PATTERN.test(name)) {
    return { error: { source, reason: `agent name "${name}" must be a single word of letters, digits, hyphens, or underscores` } }
  }
  const description = (fields.description ?? "").trim()
  if (description === "") return { error: { source, reason: "frontmatter is missing required key: description" } }
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
  if (body === "") return { error: { source, reason: "agent body (system prompt) is empty" } }
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

function collectMarkdown(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectMarkdown(full))
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full)
  }
  return files.sort()
}

export function packageAgentsDir(): string {
  return fileURLToPath(new URL("../../agents/", import.meta.url))
}

export function registryPaths(cwd: string): string[] {
  return [packageAgentsDir(), join(homedir(), ".pi", "agent", "agents"), join(cwd, ".pi", "agents")]
}

export function loadRegistry(cwd: string): AgentRegistry {
  const paths = registryPaths(cwd)
  const agents = new Map<string, AgentDefinition>()
  const errors: AgentParseError[] = []
  for (const dir of paths) {
    for (const file of collectMarkdown(dir)) {
      let text: string
      try {
        text = readFileSync(file, "utf8")
      } catch (error) {
        errors.push({ source: file, reason: `unreadable: ${describeError(error)}` })
        continue
      }
      const { definition, error } = parseAgentFile(file, text)
      if (error) errors.push(error)
      if (definition) agents.set(definition.name, definition)
    }
  }
  return { agents, errors, paths }
}
