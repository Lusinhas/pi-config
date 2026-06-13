import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Type } from "typebox"
import { StringEnum } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { defaultConfig, discover, resolvePackageRoot } from "./discovery.ts"
import type { DiscoveredResources, LoaderConfig } from "./discovery.ts"
import { runDoctor } from "./doctor.ts"
import { runSetup } from "./setup.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface ToolText {
  type: "text"
  text: string
}

interface ToolOutput {
  content: ToolText[]
  details: Record<string, unknown> | undefined
}

interface SkillToolParams {
  op: "list" | "load"
  name?: string
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key]
    if (isRecord(current) && isRecord(value)) {
      merged[key] = deepMerge(current, value)
    } else if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged
}

function normalizeConfig(raw: Record<string, unknown>): LoaderConfig {
  const exclude = Array.isArray(raw.exclude)
    ? raw.exclude.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [...defaultConfig.exclude]
  return {
    prompts: typeof raw.prompts === "boolean" ? raw.prompts : defaultConfig.prompts,
    skills: typeof raw.skills === "boolean" ? raw.skills : defaultConfig.skills,
    exclude
  }
}

export function loadConfig(): LoaderConfig {
  let merged: Record<string, unknown> = { ...defaultConfig }
  try {
    const shipped: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))
    if (isRecord(shipped)) merged = deepMerge(merged, shipped)
  } catch {
    merged = { ...merged }
  }
  const overrides = [join(homedir(), ".pi", "agent", "suite.json"), join(process.cwd(), ".pi", "suite.json")]
  for (const file of overrides) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (isRecord(parsed) && isRecord(parsed.loader)) merged = deepMerge(merged, parsed.loader)
    } catch {
      continue
    }
  }
  return normalizeConfig(merged)
}

export default function loader(pi: ExtensionAPI): void {
  pi.on("resources_discover", (): DiscoveredResources => {
    const resources = discover(resolvePackageRoot(), loadConfig())
    return { promptPaths: resources.promptPaths, skillPaths: resources.skillPaths }
  })
  pi.registerTool({
    name: "skill",
    label: "Skill",
    description:
      "Skills are focused instruction sets for specialized tasks: git workflows (commit, rebase, PR, conflicts), code and security review, testing, debugging, CI, releases, refactoring, codebase and web research, UI work, and repo onboarding. op \"list\" returns every skill with a one-line description; op \"load\" returns one skill's full instructions by name. When a task matches a skill, load it before starting and follow its instructions.",
    parameters: Type.Object({
      op: StringEnum(["list", "load"], { description: "list all skills or load one skill's instructions" }),
      name: Type.Optional(Type.String({ description: "Skill name (required for load)" }))
    }),
    execute: async (_toolCallId: string, params: SkillToolParams): Promise<ToolOutput> => {
      const skills = pi.getCommands().filter((command) => command.source === "skill")
      const nameOf = (command: { name: string }): string => command.name.replace(/^skill:/, "")
      if (params.op === "list") {
        if (skills.length === 0) {
          return { content: [{ type: "text", text: "No skills are available." }], details: undefined }
        }
        const lines = skills.map((command) => `${nameOf(command)} — ${command.description ?? ""}`).sort()
        return { content: [{ type: "text", text: lines.join("\n") }], details: undefined }
      }
      const wanted = (params.name ?? "").trim().replace(/^skill:/, "")
      if (wanted === "") throw new Error("skill: name is required for load")
      const found = skills.find((command) => nameOf(command) === wanted)
      if (!found) {
        const names = skills.map(nameOf).sort()
        throw new Error(`skill: unknown skill "${wanted}"${names.length > 0 ? ` (available: ${names.join(", ")})` : ""}`)
      }
      const raw = readFileSync(found.sourceInfo.path, "utf8")
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim()
      const text = `skill: ${wanted}\ndirectory: ${dirname(found.sourceInfo.path)} (resolve relative paths in the instructions against this directory)\n\n${body}`
      return { content: [{ type: "text", text }], details: undefined }
    }
  })

  pi.registerCommand("doctor", {
    description: "Check pi-config resources, agents, and suite.json files for problems",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      runDoctor(loadConfig(), ctx)
    }
  })
  pi.registerCommand("setup", {
    description: "First-run wizard: pick a theme and default approval mode",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      await runSetup(loadConfig(), ctx)
    }
  })
}
