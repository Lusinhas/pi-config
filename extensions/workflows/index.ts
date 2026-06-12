import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Type } from "typebox"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { Runner } from "../subagents/runner.ts"
import { Workflows } from "./runs.ts"
import type { ToolOutput, ToolUpdate, WorkflowParams, WorkflowsConfig } from "./runs.ts"
import { openRunViewer } from "./viewer.ts"

const defaultConfig: WorkflowsConfig = {
  timeoutSec: 1800,
  maxAgents: 250
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toCount(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  return rounded < minimum ? minimum : rounded
}

export function loadConfig(): WorkflowsConfig {
  let merged: Record<string, unknown> = { ...defaultConfig }
  try {
    const shipped: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"))
    if (isRecord(shipped)) merged = { ...merged, ...shipped }
  } catch {
    merged = { ...merged }
  }
  const overrides = [join(homedir(), ".pi", "agent", "piconfig.json"), join(process.cwd(), ".pi", "piconfig.json")]
  for (const file of overrides) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (isRecord(parsed) && isRecord(parsed.workflows)) merged = { ...merged, ...parsed.workflows }
    } catch {
      continue
    }
  }
  return {
    timeoutSec: toCount(merged.timeoutSec, defaultConfig.timeoutSec, 1),
    maxAgents: toCount(merged.maxAgents, defaultConfig.maxAgents, 1)
  }
}

export default function workflows(pi: ExtensionAPI): void {
  const config = loadConfig()
  let runner: Runner | undefined
  const sharedRunner = (): Runner => {
    if (!runner) {
      pi.events.emit("piconfig:subagents:runner", {
        provide: (instance: Runner): void => {
          runner = instance
        }
      })
    }
    if (!runner) throw new Error("workflow: the subagents extension provides the agent runner and must be loaded alongside workflows")
    return runner
  }
  const manager = new Workflows(pi, config, sharedRunner)

  pi.on("session_shutdown", () => {
    try {
      manager.killAll()
      manager.stopDeliveries()
    } catch {}
  })

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: manager.description(),
    parameters: Type.Object({
      script: Type.Optional(Type.String({ description: "Inline workflow script; the first statement must be export const meta = { name, description, phases }" })),
      name: Type.Optional(Type.String({ description: "Name of a saved workflow script from .pi/workflows or ~/.pi/agent/workflows (file name without extension)" })),
      args: Type.Optional(Type.String({ description: "JSON value exposed to the script as the args global" })),
      budget: Type.Optional(Type.Number({ description: "Advisory token target exposed to the script as budget {total, spent(), remaining()}; not enforced" })),
      background: Type.Optional(Type.Boolean({ description: "Run in the background and deliver the result as a follow-up message" }))
    }),
    execute: async (_toolCallId: string, params: WorkflowParams, signal: AbortSignal | undefined, onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolOutput> => {
      return await manager.execute(params, signal, onUpdate, ctx)
    }
  })

  pi.registerCommand("workflows", {
    description: "List saved workflow scripts and runs, or manage them: /workflows view (live viewer), /workflows show <runId>, /workflows kill <runId>",
    getArgumentCompletions: (prefix: string): Array<{ value: string; label: string }> | null => {
      const needle = prefix.trim().toLowerCase()
      const items = [
        { value: "view", label: "view — open the live workflow run viewer" },
        { value: "show", label: "show <runId> — print a run's log lines" },
        { value: "kill", label: "kill <runId> — abort a running workflow" }
      ].filter((item) => item.value.startsWith(needle))
      return items.length > 0 ? items : null
    },
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (args.trim().split(/\s+/)[0] === "view") {
        if (!ctx.hasUI) return
        await openRunViewer(ctx, manager)
        return
      }
      await manager.command(args, ctx)
    }
  })
}
