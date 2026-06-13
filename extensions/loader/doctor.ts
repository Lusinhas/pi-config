import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, relative } from "node:path"
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { discover, isDirectory, resolvePackageRoot, walkFiles } from "./discovery.ts"
import type { LoaderConfig } from "./discovery.ts"

export interface ParsedFrontmatter {
  ok: boolean
  hasFrontmatter: boolean
  data: Record<string, string>
  body: string
  error?: string
}

const blockScalars = new Set(["|", "|-", "|+", ">", ">-", ">+"])
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"])

interface NameRecord {
  name: string
  path: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const cleaned = text.replace(/^\uFEFF/, "")
  const lines = cleaned.split(/\r\n|\r|\n/)
  if ((lines[0] ?? "").trim() !== "---") {
    return { ok: true, hasFrontmatter: false, data: {}, body: cleaned }
  }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === "---" || trimmed === "...") {
      end = i
      break
    }
  }
  if (end === -1) {
    return { ok: false, hasFrontmatter: true, data: {}, body: "", error: "unterminated frontmatter block" }
  }
  const data: Record<string, string> = {}
  const body = lines.slice(end + 1).join("\n")
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    if (/^\s/.test(line)) continue
    if (trimmed.startsWith("- ")) continue
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!match) {
      return { ok: false, hasFrontmatter: true, data, body, error: `invalid frontmatter line ${i + 1}: ${trimmed}` }
    }
    const key = match[1]
    let value = match[2].trim()
    if (blockScalars.has(value)) {
      const parts: string[] = []
      let j = i + 1
      while (j < end && (lines[j].trim().length === 0 || /^\s/.test(lines[j]))) {
        if (lines[j].trim().length > 0) parts.push(lines[j].trim())
        j++
      }
      value = parts.join(" ")
      i = j - 1
    } else {
      value = stripQuotes(value)
    }
    data[key] = value
  }
  return { ok: true, hasFrontmatter: true, data, body }
}

function findDuplicates(records: NameRecord[], category: string, errors: string[]): void {
  const byName = new Map<string, string[]>()
  for (const record of records) {
    const list = byName.get(record.name) ?? []
    list.push(record.path)
    byName.set(record.name, list)
  }
  for (const [name, paths] of byName) {
    if (paths.length > 1) {
      errors.push(`duplicate ${category} name "${name}": ${paths.join(", ")}`)
    }
  }
}

function readText(file: string, rel: string, errors: string[]): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch (err) {
    errors.push(`${rel}: unreadable (${message(err)})`)
    return undefined
  }
}

export function runDoctor(config: LoaderConfig, ctx: ExtensionCommandContext): void {
  const errors: string[] = []
  const warnings: string[] = []
  const root = resolvePackageRoot()
  const rel = (path: string): string => relative(root, path) || "."
  const rootOk = existsSync(join(root, "package.json"))
  if (!rootOk) errors.push(`package root ${root} has no package.json`)
  for (const dirName of ["skills", "prompts", "themes", "agents"]) {
    if (!isDirectory(join(root, dirName))) warnings.push(`${dirName}/ directory missing under package root`)
  }
  if (!config.skills) warnings.push("skill discovery disabled in loader config")
  if (!config.prompts) warnings.push("prompt discovery disabled in loader config")

  const resources = discover(root, { ...config, prompts: true, skills: true })
  const skillPaths = resources.skillPaths ?? []
  const promptPaths = resources.promptPaths ?? []
  const themePaths = resources.themePaths ?? []

  const skillNames: NameRecord[] = []
  for (const dir of skillPaths) {
    const file = join(dir, "SKILL.md")
    const text = readText(file, rel(file), errors)
    if (text === undefined) continue
    const fm = parseFrontmatter(text)
    if (!fm.ok) {
      errors.push(`${rel(file)}: ${fm.error}`)
      continue
    }
    if (!fm.hasFrontmatter) {
      errors.push(`${rel(file)}: missing frontmatter`)
    } else {
      if (!(fm.data.name ?? "").trim()) errors.push(`${rel(file)}: frontmatter missing name`)
      if (!(fm.data.description ?? "").trim()) errors.push(`${rel(file)}: frontmatter missing description`)
    }
    const name = (fm.data.name ?? "").trim()
    skillNames.push({ name: name.length > 0 ? name : basename(dir), path: rel(dir) })
  }

  const promptNames: NameRecord[] = []
  for (const file of promptPaths) {
    const text = readText(file, rel(file), errors)
    if (text === undefined) continue
    const fm = parseFrontmatter(text)
    if (!fm.ok) errors.push(`${rel(file)}: ${fm.error}`)
    promptNames.push({ name: basename(file, ".md"), path: rel(file) })
  }

  const themeNames: NameRecord[] = []
  for (const file of themePaths) {
    const text = readText(file, rel(file), errors)
    if (text === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      errors.push(`${rel(file)}: invalid JSON (${message(err)})`)
      continue
    }
    if (!isRecord(parsed)) {
      errors.push(`${rel(file)}: theme must be a JSON object`)
      continue
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : ""
    if (name.length === 0) errors.push(`${rel(file)}: theme missing name`)
    const colors = parsed.colors
    if (!isRecord(colors)) {
      errors.push(`${rel(file)}: theme missing colors object`)
    } else {
      const keys = Object.keys(colors)
      if (keys.length !== 51) errors.push(`${rel(file)}: colors has ${keys.length} keys, expected exactly 51`)
      const nonString = keys.filter((key) => typeof colors[key] !== "string")
      if (nonString.length > 0) warnings.push(`${rel(file)}: non-string color values: ${nonString.join(", ")}`)
    }
    themeNames.push({ name: name.length > 0 ? name : basename(file, ".json"), path: rel(file) })
  }

  const agentNames: NameRecord[] = []
  const agentFiles = walkFiles(join(root, "agents"), root, config.exclude, (name) => name.endsWith(".md"))
  for (const file of agentFiles) {
    const text = readText(file, rel(file), errors)
    if (text === undefined) continue
    const fm = parseFrontmatter(text)
    if (!fm.ok) {
      errors.push(`${rel(file)}: ${fm.error}`)
      continue
    }
    if (!fm.hasFrontmatter) {
      errors.push(`${rel(file)}: missing frontmatter`)
      agentNames.push({ name: basename(file, ".md"), path: rel(file) })
      continue
    }
    const name = (fm.data.name ?? "").trim()
    if (name.length === 0) errors.push(`${rel(file)}: frontmatter missing name`)
    else if (/\s/.test(name)) errors.push(`${rel(file)}: agent name "${name}" must be a single word`)
    if (!(fm.data.description ?? "").trim()) errors.push(`${rel(file)}: frontmatter missing description`)
    if (!(fm.data.model ?? "").trim()) errors.push(`${rel(file)}: frontmatter missing model`)
    if (!(fm.data.tools ?? "").trim()) errors.push(`${rel(file)}: frontmatter missing tools`)
    const thinking = (fm.data.thinking ?? "").trim()
    if (thinking.length === 0) errors.push(`${rel(file)}: frontmatter missing thinking`)
    else if (!thinkingLevels.has(thinking)) {
      errors.push(`${rel(file)}: invalid thinking level "${thinking}" (expected off|minimal|low|medium|high|xhigh)`)
    }
    if (fm.body.trim().length === 0) warnings.push(`${rel(file)}: empty system prompt body`)
    agentNames.push({ name: name.length > 0 ? name : basename(file, ".md"), path: rel(file) })
  }

  findDuplicates(skillNames, "skill", errors)
  findDuplicates(promptNames, "prompt", errors)
  findDuplicates(themeNames, "theme", errors)
  findDuplicates(agentNames, "agent", errors)

  const suiteConfigLines: string[] = []
  const candidates = [
    { label: "~/.pi/agent/suite.json", path: join(homedir(), ".pi", "agent", "suite.json") },
    { label: ".pi/suite.json", path: join(ctx.cwd, ".pi", "suite.json") }
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      suiteConfigLines.push(`  ${candidate.label}: not present`)
      continue
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate.path, "utf8"))
      if (isRecord(parsed)) {
        suiteConfigLines.push(`  ${candidate.label}: ok (${Object.keys(parsed).length} sections)`)
      } else {
        suiteConfigLines.push(`  ${candidate.label}: INVALID`)
        errors.push(`${candidate.label}: top level must be a JSON object`)
      }
    } catch (err) {
      suiteConfigLines.push(`  ${candidate.label}: INVALID`)
      errors.push(`${candidate.label}: invalid JSON (${message(err)})`)
    }
  }

  const lines: string[] = []
  lines.push(`pi-config doctor — ${root}`)
  lines.push(`package root: ${rootOk ? "ok" : "MISSING package.json"}`)
  lines.push(
    `skills: ${skillPaths.length}  prompts: ${promptPaths.length}  themes: ${themePaths.length}  agents: ${agentFiles.length}`
  )
  lines.push("suite.json:")
  lines.push(...suiteConfigLines)
  if (errors.length > 0) {
    lines.push("errors:")
    for (const item of errors) lines.push(`  ${item}`)
  }
  if (warnings.length > 0) {
    lines.push("warnings:")
    for (const item of warnings) lines.push(`  ${item}`)
  }
  const total = skillPaths.length + promptPaths.length + themePaths.length + agentFiles.length
  lines.push(`summary: ${total} resources checked, ${errors.length} error(s), ${warnings.length} warning(s)`)
  const report = lines.join("\n")
  if (ctx.hasUI) {
    ctx.ui.notify(report, errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "info")
  } else {
    console.log(report)
  }
}
