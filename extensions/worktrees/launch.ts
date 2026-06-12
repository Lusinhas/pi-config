import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { detectRepo, findEntry, isInside, worktreeBase } from "./manage"
import type { WorktreeConfig, WorktreeEntry } from "./manage"

export interface LaunchOutcome {
  text: string
  severity: "info" | "warning"
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function launchInstructions(entry: WorktreeEntry): string {
  const branch = entry.branch ?? `detached at ${entry.head.slice(0, 9)}`
  return [
    `Worktree ready at ${entry.path} (${branch}).`,
    "pi cannot change its working directory mid-session, so start a fresh session inside the worktree yourself:",
    `  cd ${shellQuote(entry.path)} && pi`,
    "or resume a previous session that already lives there:",
    `  cd ${shellQuote(entry.path)} && pi --resume`
  ].join("\n")
}

export async function spawnShell(pi: ExtensionAPI, config: WorktreeConfig, path: string): Promise<string> {
  const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL.trim() : "/bin/sh"
  const command = `cd ${shellQuote(path)} && nohup ${shellQuote(shell)} -lc ${shellQuote(config.spawnCommand)} >/dev/null 2>&1 &`
  const result = await pi.exec("/bin/sh", ["-c", command], { timeout: 10000 })
  const code = typeof result.code === "number" ? result.code : -1
  if (code !== 0) {
    throw new Error(`Failed to spawn shell: ${(result.stderr || result.stdout).trim() || `exit code ${code}`}`)
  }
  return `Spawned a detached ${shell} running "${config.spawnCommand}" in ${path}. It has no terminal attached, so prefer running the printed command in your own terminal.`
}

export async function openWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: WorktreeConfig,
  name: string
): Promise<LaunchOutcome> {
  const repo = await detectRepo(pi, ctx.cwd, config)
  const base = worktreeBase(config, repo.mainRoot)
  const entry = findEntry(repo.entries, base, name)
  if (!entry) {
    throw new Error(`No worktree named "${name}"; create it with /worktree new ${name}`)
  }
  if (entry.isMain) {
    throw new Error(`"${name}" is the main worktree at ${entry.path}; this session already manages it`)
  }
  if (isInside(ctx.cwd, entry.path)) {
    return { text: `Already inside worktree "${name}" at ${entry.path}.`, severity: "info" }
  }
  if (entry.prunable) {
    return {
      text: `Worktree "${name}" is prunable (${entry.prunableReason || "directory missing"}); run /worktree clean and recreate it.`,
      severity: "warning"
    }
  }
  const lines = [launchInstructions(entry)]
  if (config.allowSpawn && ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      "Spawn shell",
      `Start a detached shell running "${config.spawnCommand}" in ${entry.path}?`
    )
    if (confirmed) lines.push(await spawnShell(pi, config, entry.path))
    else lines.push("Spawn declined; run the command above manually.")
  } else if (config.allowSpawn) {
    lines.push("allowSpawn is enabled but no UI is available; run the command above manually.")
  }
  return { text: lines.join("\n"), severity: "info" }
}
