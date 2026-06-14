import { completeSimple } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { AutocompleteItem } from "@earendil-works/pi-tui"
import { GoalEngine, LOOP_ENTRY } from "../goals/index.ts"
import type { EnginePorts, NotifyLevel } from "../goals/index.ts"
import { Judge } from "../goals/judge.ts"
import type { CompleteRequest, CompleteResponse, JudgeRegistry } from "../goals/judge.ts"
import { LoopRunner } from "../goals/loop.ts"
import type { LoopSpec } from "../goals/loop.ts"
import type { GoalsConfig } from "../goals/config.ts"

interface AgentEndEvent {
  messages?: unknown
}

export class GoalsRegistrar {
  private readonly pi: ExtensionAPI
  private readonly engine: GoalEngine
  private ctx: ExtensionContext | undefined
  private judging = false

  constructor(pi: ExtensionAPI, config: GoalsConfig) {
    this.pi = pi
    const judge = new Judge((model, request, options) =>
      completeSimple(model as never, request as CompleteRequest as never, options as never) as Promise<CompleteResponse>
    )
    const loop = new LoopRunner({
      send: (prompt: string): void => {
        pi.sendUserMessage(prompt)
      },
      isIdle: (): boolean => {
        const ctx = this.ctx

        if (!ctx) {
          return false
        }

        try {
          return ctx.isIdle() && !ctx.hasPendingMessages()
        } catch {
          return false
        }
      },
      persist: (active: boolean, spec?: LoopSpec): void => {
        try {
          if (active && spec) {
            pi.appendEntry(LOOP_ENTRY, {
              active: true,
              intervalMs: spec.intervalMs,
              intervalLabel: spec.intervalLabel,
              prompt: spec.prompt,
              startedAt: spec.startedAt
            })
          } else {
            pi.appendEntry(LOOP_ENTRY, { active: false })
          }
        } catch {
          return
        }
      }
    })
    const ports: EnginePorts = {
      notify: (message: string, level: NotifyLevel): void => {
        const ctx = this.ctx

        if (!ctx || !ctx.hasUI) {
          return
        }

        try {
          ctx.ui.notify(message, level)
        } catch {
          return
        }
      },
      setStatus: (text: string | undefined): void => {
        const ctx = this.ctx

        if (!ctx || !ctx.hasUI) {
          return
        }

        try {
          ctx.ui.setStatus("goals", text)
        } catch {
          return
        }
      },
      sendUserMessage: (prompt: string, options?: { deliverAs: "followUp" }): void => {
        pi.sendUserMessage(prompt, options)
      },
      appendEntry: (customType: string, data: Record<string, unknown>): void => {
        pi.appendEntry(customType, data)
      },
      registry: (): JudgeRegistry => (this.ctx?.modelRegistry ?? {}) as unknown as JudgeRegistry,
      entries: (): readonly unknown[] => {
        const ctx = this.ctx

        if (!ctx) {
          return []
        }

        return ctx.sessionManager.getEntries()
      }
    }
    this.engine = new GoalEngine(config, judge, loop, ports)
  }

  register(): void {
    const pi = this.pi

    pi.events.on("piconfig:todos", (payload: unknown) => {
      this.engine.ingestTodos(payload)
    })

    pi.on("session_start", (_event, ctx) => {
      this.ctx = ctx
      this.engine.restore()
    })

    pi.on("session_shutdown", () => {
      this.engine.shutdown()
    })

    pi.on("agent_end", async (event, ctx) => {
      this.ctx = ctx

      if (this.judging) {
        return
      }

      this.judging = true

      try {
        const messages = (event as AgentEndEvent)?.messages
        await this.engine.judgeAfterAgent(Array.isArray(messages) ? messages : [])
      } finally {
        this.judging = false
      }
    })

    pi.registerCommand("goal", {
      description: "Arm a completion condition judged after every agent run (/goal <condition> | status | off)",
      handler: async (args, ctx) => {
        this.ctx = ctx
        this.engine.handleGoal(args)
      },
      getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
        const options: AutocompleteItem[] = [
          { value: "status", label: "status", description: "Show goal and loop state" },
          { value: "off", label: "off", description: "Clear the active goal" }
        ]
        const filtered = options.filter((option) => option.value.startsWith(prefix.toLowerCase()))

        return filtered.length > 0 ? filtered : null
      }
    })

    pi.registerCommand("loop", {
      description: "Re-send a prompt on an interval while the session is idle (/loop <interval> <prompt> | off)",
      handler: async (args, ctx) => {
        this.ctx = ctx
        this.engine.handleLoop(args)
      },
      getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
        const options: AutocompleteItem[] = [
          { value: "off", label: "off", description: "Cancel the active loop" },
          { value: "30s", label: "30s", description: "Every 30 seconds" },
          { value: "5m", label: "5m", description: "Every 5 minutes" },
          { value: "1h", label: "1h", description: "Every hour" }
        ]
        const filtered = options.filter((option) => option.value.startsWith(prefix.toLowerCase()))

        return filtered.length > 0 ? filtered : null
      }
    })
  }
}
