import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { loadRegistry } from "../subagents/registry.ts"
import type { Runner } from "../subagents/index.ts"
import { Workflows } from "../workflows/index.ts"
import { ViewerRenderer } from "../workflows/render.ts"
import type {
  AgentRegistry,
  DeliveryMessage,
  RunContext,
  RunEntry,
  RunRecord,
  ToolOutput,
  ToolUpdate,
  WorkflowParams,
  WorkflowsConfig,
  WorkflowsHost
} from "../workflows/index.ts"

interface ThemeLike {
  fg?: (color: never, text: string) => string
}

function paint(theme: ThemeLike | undefined, color: string, text: string): string {
  if (!theme || typeof theme.fg !== "function") {
    return text
  }

  try {
    return theme.fg(color as never, text)
  } catch {
    return text
  }
}

export class WorkflowsRegistrar {
  private readonly pi: ExtensionAPI
  private readonly workflows: Workflows

  constructor(pi: ExtensionAPI, config: WorkflowsConfig, runner: Runner) {
    this.pi = pi
    const host: WorkflowsHost = {
      appendRun: (entry: RunEntry): void => {
        try {
          pi.appendEntry("workflows:run", { ...entry })
        } catch {
          return
        }
      },
      sendResult: (message: DeliveryMessage): void => {
        try {
          pi.sendMessage(message as never, { deliverAs: "followUp", triggerTurn: true } as never)
        } catch {
          return
        }
      }
    }
    this.workflows = new Workflows(config, host, runner, (cwd: string): AgentRegistry => loadRegistry(cwd))
  }

  register(): void {
    const pi = this.pi
    const workflows = this.workflows

    pi.registerTool({
      name: "workflow",
      label: "Workflow",
      description: workflows.description(),
      parameters: Type.Object({
        script: Type.Optional(Type.String({ description: "Inline workflow script; the first statement must be export const meta = { name, description, phases }" })),
        name: Type.Optional(Type.String({ description: "Name of a saved workflow script from .pi/workflows or ~/.pi/agent/workflows (file name without extension)" })),
        args: Type.Optional(Type.String({ description: "JSON value exposed to the script as the args global" })),
        budget: Type.Optional(Type.Number({ description: "Advisory token target exposed to the script as budget {total, spent(), remaining()}; not enforced" })),
        background: Type.Optional(Type.Boolean({ description: "Run in the background and deliver the result as a follow-up message" })),
        maxTokens: Type.Optional(Type.Number({ description: "Per-agent token ceiling for agents this run spawns; unset or 0 means unbounded" })),
        maxAgents: Type.Optional(Type.Number({ description: "Override the fan-out cap (max agents) for this run" }))
      }),
      execute: (toolCallId: string, params: WorkflowParams, signal: AbortSignal | undefined, onUpdate: ToolUpdate, ctx: ExtensionContext): Promise<ToolOutput> => {
        return workflows.execute(params, signal, onUpdate, this.runContext(ctx))
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
          if (!ctx.hasUI) {
            return
          }

          await this.openRunViewer(ctx)

          return
        }

        await workflows.command(args, this.runContext(ctx))
      }
    })
  }

  shutdown(): void {
    try {
      this.workflows.killAll()
      this.workflows.stopDeliveries()
    } catch {
      return
    }
  }

  private runContext(ctx: ExtensionContext | ExtensionCommandContext): RunContext {
    return {
      cwd: ctx.cwd,
      hasUI: ctx.hasUI,
      model: ctx.model,
      modelRegistry: ctx.modelRegistry,
      isProjectTrusted: (): boolean => ctx.isProjectTrusted(),
      isIdle: (): boolean => ctx.isIdle(),
      getEntries: (): unknown[] => ctx.sessionManager.getEntries(),
      notify: (message: string, level: "info" | "warning" | "error"): void => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, level)
        }
      }
    }
  }

  private async openRunViewer(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      return
    }

    const workflows = this.workflows
    await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => {
      let view: "list" | "detail" = "list"
      let index = 0
      let scroll = 0
      const refresh = (): void => {
        try {
          tui.requestRender()
        } catch {
          return
        }
      }
      const ticker = setInterval(refresh, 1000)
      const themed = theme as unknown as ThemeLike
      const selected = (): RunRecord | undefined => workflows.listRuns()[index]

      return {
        render(width: number): string[] {
          const now = Date.now()
          const runs = workflows.listRuns()

          if (index >= runs.length) {
            index = Math.max(0, runs.length - 1)
          }

          const lines: string[] = [""]

          if (view === "list") {
            lines.push(paint(themed, "accent", `Workflow runs — ${runs.filter((record) => record.state === "running").length} running, ${runs.length} total`))
            lines.push("")

            if (runs.length === 0) {
              lines.push(paint(themed, "dim", "No workflows have run in this session."))
            }

            runs.forEach((record, position) => {
              const mark = ViewerRenderer.glyph(record.state)
              const row = `${paint(themed, mark.color, mark.mark)} ${ViewerRenderer.runLine(record, now)}`
              const pointer = position === index ? paint(themed, "accent", "› ") : "  "
              lines.push(truncateToWidth(`${pointer}${row}`, width))
            })
            lines.push("")
            lines.push(paint(themed, "dim", "↑/↓ select · enter logs · x kill · q close"))
            lines.push("")

            return lines
          }

          const record = selected()

          if (!record) {
            view = "list"

            return [paint(themed, "dim", "run disappeared; press any key")]
          }

          const mark = ViewerRenderer.glyph(record.state)
          lines.push(paint(themed, "accent", `${mark.mark} ${record.name} ${record.id} [${record.state}]`) + paint(themed, "dim", ` · ${record.agentCount} agents · ${record.tokens} tokens · ${ViewerRenderer.elapsed(record, now)}`))
          const phases = ViewerRenderer.phaseSummary(record)

          if (phases !== "") {
            lines.push(paint(themed, "dim", `phases: ${phases}`))
          }

          if (record.result !== undefined && record.result !== "") {
            lines.push(truncateToWidth(paint(themed, "dim", `result: ${record.result}`), width))
          }

          lines.push("")
          const body = record.logs.map((line) => truncateToWidth(line, width))
          const height = 18
          const maxScroll = Math.max(0, body.length - height)

          if (scroll > maxScroll) {
            scroll = maxScroll
          }

          const start = Math.max(0, body.length - height - scroll)

          if (body.length === 0) {
            lines.push(paint(themed, "dim", "(no log lines were recorded)"))
          }

          lines.push(...body.slice(start, start + height))

          if (start > 0) {
            lines.push(paint(themed, "dim", `… ${start} earlier lines (↑ to scroll)`))
          }

          lines.push("")
          lines.push(paint(themed, "dim", "↑/↓ scroll · esc back · x kill · q close"))
          lines.push("")

          return lines
        },
        handleInput(data: string): void {
          const runs = workflows.listRuns()

          if (matchesKey(data, "escape")) {
            if (view === "detail") {
              view = "list"
              scroll = 0
              refresh()

              return
            }

            clearInterval(ticker)
            done(undefined)

            return
          }

          if (data === "q") {
            clearInterval(ticker)
            done(undefined)

            return
          }

          if (matchesKey(data, "up")) {
            if (view === "list") {
              index = Math.max(0, index - 1)
            } else {
              scroll += 1
            }

            refresh()

            return
          }

          if (matchesKey(data, "down")) {
            if (view === "list") {
              index = Math.min(Math.max(0, runs.length - 1), index + 1)
            } else {
              scroll = Math.max(0, scroll - 1)
            }

            refresh()

            return
          }

          if (matchesKey(data, "enter") && view === "list" && runs.length > 0) {
            view = "detail"
            scroll = 0
            refresh()

            return
          }

          if (data === "x") {
            const record = selected()

            if (record) {
              workflows.killRun(record.id)
              refresh()
            }
          }
        },
        invalidate(): void {},
        dispose(): void {
          clearInterval(ticker)
        }
      }
    })
  }
}
