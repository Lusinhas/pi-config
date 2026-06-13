import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { resolvePackageRoot, walkFiles } from "./discovery.ts"
import type { LoaderConfig } from "./discovery.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function themeChoices(root: string, exclude: string[]): string[] {
  const files = walkFiles(join(root, "themes"), root, exclude, (name) => name.endsWith(".json"))
  const names = new Set<string>()
  for (const file of files) {
    let added = false
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (isRecord(parsed) && typeof parsed.name === "string" && parsed.name.trim().length > 0) {
        names.add(parsed.name.trim())
        added = true
      }
    } catch {
      added = false
    }
    if (!added) names.add(basename(file, ".json"))
  }
  return [...names].sort()
}

export async function runSetup(config: LoaderConfig, ctx: ExtensionCommandContext): Promise<void> {
  const target = join(homedir(), ".pi", "agent", "suite.json")
  if (!ctx.hasUI) {
    console.log(
      `/setup needs the interactive TUI; this session has no UI. Start pi in TUI mode and run /setup again, or set "theme" in ~/.pi/agent/settings.json and edit ${target} by hand using section "permissions".`
    )
    return
  }
  const root = resolvePackageRoot()

  let appliedTheme: string | undefined
  const themes = themeChoices(root, config.exclude)
  if (themes.length > 0) {
    const pick = await ctx.ui.select("Choose a theme", [...themes, "skip"])
    if (pick === undefined) {
      ctx.ui.notify("Setup cancelled; nothing was written.", "warning")
      return
    }
    if (pick !== "skip") {
      const result = ctx.ui.setTheme(pick)
      if (result.success) {
        appliedTheme = pick
      } else {
        ctx.ui.notify(`Theme "${pick}" could not be applied: ${result.error ?? "unknown error"}`, "warning")
      }
    }
  } else {
    ctx.ui.notify("No themes found under themes/; skipping theme selection.", "warning")
  }

  const modePick = await ctx.ui.select(
    "Default approval mode — ask: confirm every risky tool, auto: a judge model approves safe actions and asks otherwise, write: auto-approve file edits but confirm commands, yolo: never ask",
    ["ask", "auto", "write", "yolo", "skip"]
  )
  if (modePick === undefined) {
    ctx.ui.notify("Setup cancelled; nothing was written.", "warning")
    return
  }
  const chosenMode = modePick === "skip" ? undefined : modePick
  let existing: Record<string, unknown> = {}
  if (existsSync(target)) {
    let valid = false
    try {
      const parsed: unknown = JSON.parse(readFileSync(target, "utf8"))
      if (isRecord(parsed)) {
        existing = parsed
        valid = true
      }
    } catch {
      valid = false
    }
    if (!valid) {
      const overwrite = await ctx.ui.confirm(
        "Invalid suite.json",
        `${target} is not a valid JSON object. Overwrite it with fresh setup values?`
      )
      if (!overwrite) {
        ctx.ui.notify(`Left ${target} untouched; fix its JSON and rerun /setup.`, "warning")
        return
      }
    }
  }

  const next: Record<string, unknown> = { ...existing }
  const written: string[] = []
  const kept: string[] = []
  if (isRecord(next.loader) && "theme" in next.loader) {
    const section = { ...next.loader }
    delete section.theme
    if (Object.keys(section).length === 0) delete next.loader
    else next.loader = section
    written.push("removed stale loader.theme (the theme now persists in settings.json)")
  }
  if (chosenMode !== undefined) {
    const section = isRecord(next.permissions) ? { ...next.permissions } : {}
    if (section.mode === chosenMode) {
      kept.push(`permissions.mode already "${chosenMode}"`)
    } else {
      section.mode = chosenMode
      next.permissions = section
      written.push(`permissions.mode = "${chosenMode}"`)
    }
  }

  if (written.length === 0) {
    const notes = [...kept]
    if (appliedTheme !== undefined) notes.unshift(`theme "${appliedTheme}" applied and saved to settings.json`)
    const detail = notes.length > 0 ? ` (${notes.join("; ")})` : ""
    ctx.ui.notify(`Nothing to change; ${target} left as is${detail}.`, "info")
    return
  }
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(next, null, 2) + "\n", "utf8")
  } catch (err) {
    ctx.ui.notify(`Failed to write ${target}: ${message(err)}`, "error")
    return
  }
  const lines = [`Setup complete — wrote ${target}`]
  if (appliedTheme !== undefined) lines.push(`  theme = "${appliedTheme}" (applied and saved to settings.json)`)
  for (const item of written) lines.push(`  ${item}`)
  for (const item of kept) lines.push(`  ${item}`)
  ctx.ui.notify(lines.join("\n"), "info")
}
