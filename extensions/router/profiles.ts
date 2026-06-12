import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { asThinking, describeModel, errorText, isRecord, listModels, notify, resolveModel, sameModel } from "./models"
import type { AgentModel, ThinkingLevel } from "./models"

export interface ProfileSpec {
  model?: string
  thinking?: ThinkingLevel
  theme?: string
  tools?: string[]
  style?: string
}

export function parseProfiles(raw: unknown): Record<string, ProfileSpec> {
  const profiles: Record<string, ProfileSpec> = {}
  if (!isRecord(raw)) return profiles
  for (const [name, value] of Object.entries(raw)) {
    if (name.trim() === "" || name.trim().toLowerCase() === "off" || !isRecord(value)) continue
    const spec: ProfileSpec = {}
    if (typeof value.model === "string" && value.model.trim() !== "") spec.model = value.model.trim()
    const thinking = asThinking(value.thinking)
    if (thinking) spec.thinking = thinking
    if (typeof value.theme === "string" && value.theme.trim() !== "") spec.theme = value.theme.trim()
    if (Array.isArray(value.tools)) {
      spec.tools = value.tools
        .filter((tool): tool is string => typeof tool === "string" && tool.trim() !== "")
        .map((tool) => tool.trim())
    }
    if (typeof value.style === "string" && value.style.trim() !== "") spec.style = value.style.trim()
    if (Object.keys(spec).length > 0) profiles[name] = spec
  }
  return profiles
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function settingsTheme(cwd: string): string | undefined {
  const files = [join(cwd, ".pi", "settings.json"), join(homedir(), ".pi", "agent", "settings.json")]
  for (const file of files) {
    const parsed = readJson(file)
    if (parsed && typeof parsed.theme === "string" && parsed.theme.trim() !== "") return parsed.theme.trim()
  }
  return undefined
}

function styleActive(cwd: string): string | undefined {
  const files = [join(cwd, ".pi", "suite.json"), join(homedir(), ".pi", "agent", "suite.json")]
  for (const file of files) {
    const parsed = readJson(file)
    if (!parsed || !isRecord(parsed.styles)) continue
    const value = parsed.styles.active
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return undefined
}

function writeStyle(cwd: string, style: string | undefined): boolean {
  const project = join(cwd, ".pi", "suite.json")
  const target = existsSync(project) ? project : join(homedir(), ".pi", "agent", "suite.json")
  let parsed: Record<string, unknown> = {}
  if (existsSync(target)) {
    const loaded = readJson(target)
    if (!loaded) return false
    parsed = loaded
  }
  const styles = isRecord(parsed.styles) ? { ...parsed.styles } : {}
  if (style === undefined) delete styles.active
  else styles.active = style
  parsed.styles = styles
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
    return true
  } catch {
    return false
  }
}

interface Snapshot {
  model: AgentModel | null
  thinking: ThinkingLevel | undefined
  tools: string[]
  theme: string | undefined
  style: string | undefined
  modelChanged: boolean
  thinkingChanged: boolean
  toolsChanged: boolean
  themeChanged: boolean
  styleChanged: boolean
}

export function registerProfiles(pi: ExtensionAPI, profiles: Record<string, ProfileSpec>): void {
  let snapshot: Snapshot | null = null
  let activeProfile: string | undefined

  pi.registerFlag("profile", {
    description: "Apply the named router profile (model, thinking, theme, tools, style) at session start",
    type: "string",
    default: ""
  })

  const knownTools = (): string[] => {
    try {
      const tools: unknown = pi.getAllTools()
      if (!Array.isArray(tools)) return []
      const names: string[] = []
      for (const tool of tools) {
        if (typeof tool === "string" && tool.trim() !== "") {
          names.push(tool.trim())
        } else if (isRecord(tool) && typeof tool.name === "string" && tool.name.trim() !== "") {
          names.push(tool.name.trim())
        }
      }
      return names
    } catch {
      return []
    }
  }

  const applyTheme = (ctx: ExtensionContext, theme: string): string | undefined => {
    try {
      const outcome: unknown = ctx.ui.setTheme(theme)
      if (!isRecord(outcome)) return undefined
      if (outcome.success === true) return undefined
      return typeof outcome.error === "string" && outcome.error.trim() !== "" ? outcome.error : "the theme was rejected"
    } catch (error) {
      return errorText(error)
    }
  }

  const capture = (ctx: ExtensionContext): Snapshot => {
    if (snapshot) return snapshot
    let thinking: ThinkingLevel | undefined
    try {
      thinking = asThinking(pi.getThinkingLevel())
    } catch {}
    let tools: string[] = []
    try {
      const current = pi.getActiveTools()
      if (Array.isArray(current)) tools = current.filter((tool): tool is string => typeof tool === "string")
    } catch {}
    snapshot = {
      model: ctx.model ?? null,
      thinking,
      tools,
      theme: settingsTheme(ctx.cwd),
      style: styleActive(ctx.cwd),
      modelChanged: false,
      thinkingChanged: false,
      toolsChanged: false,
      themeChanged: false,
      styleChanged: false
    }
    return snapshot
  }

  const apply = async (name: string, ctx: ExtensionContext): Promise<void> => {
    const spec = profiles[name]
    if (!spec) {
      const names = Object.keys(profiles)
      const lower = name.toLowerCase()
      const close = names.filter((candidate) => candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase()))
      const hint =
        close.length > 0
          ? ` Close matches: ${close.join(", ")}.`
          : names.length > 0
            ? ` Available: ${names.join(", ")}.`
            : " No profiles are configured (add them under router.profiles in suite.json)."
      notify(ctx, `router: unknown profile "${name}".${hint}`, "error")
      return
    }
    const state = capture(ctx)
    const applied: string[] = []
    const problems: string[] = []
    if (spec.model) {
      const resolution = await resolveModel(ctx.modelRegistry, spec.model)
      if (!resolution.model) {
        const hint = resolution.suggestions.length > 0 ? ` (close matches: ${resolution.suggestions.join(", ")})` : ""
        problems.push(`model "${spec.model}" not found in the registry${hint}`)
      } else {
        let ok = false
        try {
          ok = await pi.setModel(resolution.model)
        } catch {
          ok = false
        }
        if (ok) {
          state.modelChanged = true
          applied.push(`model ${describeModel(resolution.model)}`)
        } else {
          problems.push(`model ${describeModel(resolution.model)} was rejected`)
        }
      }
    }
    if (spec.thinking) {
      try {
        pi.setThinkingLevel(spec.thinking)
        state.thinkingChanged = true
        applied.push(`thinking ${spec.thinking}`)
      } catch {
        problems.push(`thinking level ${spec.thinking} could not be set`)
      }
    }
    if (spec.theme) {
      if (ctx.hasUI) {
        const failure = applyTheme(ctx, spec.theme)
        if (failure === undefined) {
          state.themeChanged = true
          applied.push(`theme ${spec.theme}`)
        } else {
          problems.push(`theme "${spec.theme}" could not be applied: ${failure}`)
        }
      }
    }
    if (spec.tools) {
      const all = knownTools()
      const valid = spec.tools.filter((tool) => all.includes(tool))
      const missing = spec.tools.filter((tool) => !all.includes(tool))
      if (valid.length > 0) {
        try {
          await pi.setActiveTools(valid)
          state.toolsChanged = true
          applied.push(`tools [${valid.join(", ")}]`)
          if (missing.length > 0) problems.push(`unknown tools skipped: ${missing.join(", ")}`)
        } catch {
          problems.push("active tool set could not be changed")
        }
      } else {
        problems.push(`none of the listed tools exist: ${spec.tools.join(", ")}`)
      }
    }
    if (spec.style) {
      if (writeStyle(ctx.cwd, spec.style)) {
        state.styleChanged = true
        applied.push(`style ${spec.style}`)
      } else {
        problems.push(`style "${spec.style}" could not be written to suite.json`)
      }
    }
    activeProfile = name
    const summary =
      applied.length > 0
        ? `router: profile "${name}" applied — ${applied.join(", ")}`
        : `router: profile "${name}" had nothing to apply`
    notify(ctx, problems.length > 0 ? `${summary}. Issues: ${problems.join("; ")}` : summary, problems.length > 0 ? "warning" : "info")
  }

  const revert = async (ctx: ExtensionContext): Promise<void> => {
    if (!activeProfile || !snapshot) {
      notify(ctx, "router: no profile is active", "info")
      return
    }
    const state = snapshot
    const name = activeProfile
    const restored: string[] = []
    const problems: string[] = []
    if (state.modelChanged) {
      if (state.model) {
        const models = await listModels(ctx.modelRegistry)
        const live = models.find((model) => sameModel(model, state.model as AgentModel)) ?? state.model
        let ok = false
        try {
          ok = await pi.setModel(live)
        } catch {
          ok = false
        }
        if (ok) restored.push(`model ${describeModel(live)}`)
        else problems.push(`model ${describeModel(live)} could not be restored`)
      } else {
        problems.push("the session had no model to restore")
      }
      state.modelChanged = false
    }
    if (state.thinkingChanged) {
      if (state.thinking) {
        try {
          pi.setThinkingLevel(state.thinking)
          restored.push(`thinking ${state.thinking}`)
        } catch {
          problems.push(`thinking ${state.thinking} could not be restored`)
        }
      }
      state.thinkingChanged = false
    }
    if (state.toolsChanged) {
      const all = knownTools()
      const valid = state.tools.filter((tool) => all.includes(tool))
      try {
        await pi.setActiveTools(valid)
        restored.push(`tools (${valid.length})`)
      } catch {
        problems.push("active tool set could not be restored")
      }
      state.toolsChanged = false
    }
    if (state.themeChanged) {
      if (ctx.hasUI && state.theme) {
        const failure = applyTheme(ctx, state.theme)
        if (failure === undefined) {
          restored.push(`theme ${state.theme}`)
        } else {
          problems.push(`theme ${state.theme} could not be restored: ${failure}`)
        }
      } else if (ctx.hasUI) {
        problems.push("the previous theme is unknown (none recorded in settings.json), so the theme was left as-is")
      }
      state.themeChanged = false
    }
    if (state.styleChanged) {
      if (writeStyle(ctx.cwd, state.style)) {
        restored.push(state.style ? `style ${state.style}` : "style cleared")
      } else {
        problems.push("the previous style could not be restored in suite.json")
      }
      state.styleChanged = false
    }
    activeProfile = undefined
    const summary = `router: profile "${name}" off — restored ${restored.length > 0 ? restored.join(", ") : "nothing"}`
    notify(ctx, problems.length > 0 ? `${summary}. Issues: ${problems.join("; ")}` : summary, problems.length > 0 ? "warning" : "info")
  }

  const render = (): string => {
    const names = Object.keys(profiles)
    if (names.length === 0) {
      return "router: no profiles configured (add them under router.profiles in suite.json)"
    }
    const width = names.reduce((max, name) => Math.max(max, name.length), 0)
    const lines = names.map((name) => {
      const spec = profiles[name]
      const parts: string[] = []
      if (spec.model) parts.push(`model=${spec.model}`)
      if (spec.thinking) parts.push(`thinking=${spec.thinking}`)
      if (spec.theme) parts.push(`theme=${spec.theme}`)
      if (spec.tools) parts.push(`tools=[${spec.tools.join(", ")}]`)
      if (spec.style) parts.push(`style=${spec.style}`)
      const marker = name === activeProfile ? "*" : " "
      return `${marker} ${name.padEnd(width)}  ${parts.join("  ")}`
    })
    return `Profiles (* = active, /profile <name> applies, /profile off reverts):\n${lines.join("\n")}`
  }

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    snapshot = null
    activeProfile = undefined
    const value = pi.getFlag("profile")
    if (typeof value !== "string") return
    const name = value.trim()
    if (name === "") return
    await apply(name, ctx)
  })

  pi.registerCommand("profile", {
    description: "Apply a named profile (/profile <name>), list profiles (/profile), or revert to the session snapshot (/profile off)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const name = args.trim()
      if (name === "") {
        notify(ctx, render(), "info")
        return
      }
      if (name.toLowerCase() === "off") {
        await revert(ctx)
        return
      }
      await apply(name, ctx)
    }
  })
}
