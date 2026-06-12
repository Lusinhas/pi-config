import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { asThinking, describeModel, errorText, isRecord, notify, resolveModel } from "./models"
import type { ThinkingLevel } from "./models"

export interface RoleTarget {
  model: string
  thinking?: ThinkingLevel
}

const CUSTOM_TYPE = "router:role"

export function parseRoles(raw: unknown): Record<string, RoleTarget> {
  const roles: Record<string, RoleTarget> = {}
  if (!isRecord(raw)) return roles
  for (const [name, value] of Object.entries(raw)) {
    if (name.trim() === "") continue
    if (typeof value === "string" && value.trim() !== "") {
      roles[name] = { model: value.trim() }
    } else if (isRecord(value) && typeof value.model === "string" && value.model.trim() !== "") {
      const thinking = asThinking(value.thinking)
      roles[name] = thinking ? { model: value.model.trim(), thinking } : { model: value.model.trim() }
    }
  }
  return roles
}

interface ApplyResult {
  ok: boolean
  text: string
  model?: string
}

function lastRoleFrom(ctx: ExtensionContext): string | undefined {
  let entries: unknown
  try {
    entries = ctx.sessionManager.getEntries()
  } catch {
    return undefined
  }
  if (!Array.isArray(entries)) return undefined
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue
    const data = entry.data !== undefined ? entry.data : entry.details
    if (isRecord(data) && typeof data.role === "string" && data.role.trim() !== "") return data.role
  }
  return undefined
}

export function registerRoles(pi: ExtensionAPI, roles: Record<string, RoleTarget>): void {
  let active: string | undefined

  const unknownRole = (name: string): string => {
    const names = Object.keys(roles)
    if (names.length === 0) {
      return `router: unknown role "${name}" and no roles are configured (add them under router.roles in piconfig.json)`
    }
    const lower = name.toLowerCase()
    const close = names.filter((candidate) => {
      const other = candidate.toLowerCase()
      return other.includes(lower) || lower.includes(other)
    })
    const hint = close.length > 0 ? ` Close matches: ${close.join(", ")}.` : ""
    return `router: unknown role "${name}". Available: ${names.join(", ")}.${hint}`
  }

  const applyRole = async (name: string, ctx: ExtensionContext, persist: boolean): Promise<ApplyResult> => {
    const role = roles[name]
    if (!role) return { ok: false, text: unknownRole(name) }
    const resolution = await resolveModel(ctx.modelRegistry, role.model)
    if (!resolution.model) {
      const hint = resolution.suggestions.length > 0 ? ` Close matches: ${resolution.suggestions.join(", ")}.` : ""
      return {
        ok: false,
        text: `router: role "${name}" points at model "${role.model}", which is not in the model registry.${hint}`
      }
    }
    const modelId = describeModel(resolution.model)
    let ok = false
    try {
      ok = await pi.setModel(resolution.model)
    } catch (error) {
      return { ok: false, text: `router: switching to ${modelId} failed: ${errorText(error)}` }
    }
    if (!ok) return { ok: false, text: `router: the agent rejected model ${modelId}` }
    if (role.thinking) {
      try {
        pi.setThinkingLevel(role.thinking)
      } catch {}
    }
    active = name
    try {
      pi.events.emit("piconfig:role", { role: name, model: modelId })
    } catch {}
    if (persist) {
      try {
        pi.appendEntry(CUSTOM_TYPE, { role: name, model: modelId })
      } catch {}
    }
    const thinking = role.thinking ? `, thinking ${role.thinking}` : ""
    return { ok: true, text: `router: role "${name}" active (${modelId}${thinking})`, model: modelId }
  }

  const renderRoles = async (ctx: ExtensionContext): Promise<string> => {
    const names = Object.keys(roles)
    if (names.length === 0) {
      return "router: no roles configured (add them under router.roles in piconfig.json)"
    }
    const width = names.reduce((max, name) => Math.max(max, name.length), 0)
    const lines: string[] = []
    for (const name of names) {
      const role = roles[name]
      const resolution = await resolveModel(ctx.modelRegistry, role.model)
      const target = resolution.model ? describeModel(resolution.model) : `${role.model} (not in registry)`
      const thinking = role.thinking ? `  thinking=${role.thinking}` : ""
      const marker = name === active ? "*" : " "
      lines.push(`${marker} ${name.padEnd(width)}  ${target}${thinking}`)
    }
    lines.push(`Current model: ${describeModel(ctx.model)}`)
    return `Roles (* = active, /role <name> switches):\n${lines.join("\n")}`
  }

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    active = undefined
    const name = lastRoleFrom(ctx)
    if (!name || !roles[name]) return
    const result = await applyRole(name, ctx, false)
    if (result.ok) {
      if (ctx.hasUI) notify(ctx, `router: restored role "${name}" (${result.model})`, "info")
    } else if (ctx.hasUI) {
      notify(ctx, `router: could not restore role "${name}" — ${result.text}`, "warning")
    }
  })

  pi.registerCommand("role", {
    description: "Switch model role (/role <name>) or list configured roles with the active one marked",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const name = args.trim()
      if (name === "") {
        notify(ctx, await renderRoles(ctx), "info")
        return
      }
      const result = await applyRole(name, ctx, true)
      notify(ctx, result.text, result.ok ? "info" : "error")
    }
  })
}
