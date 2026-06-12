import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { THINKING_LEVELS, asThinking, isRecord } from "./models"
import type { ThinkingLevel } from "./models"

export interface EffortConfig {
  maxBudgetTokens: number
}

type EffortLevel = ThinkingLevel | "max"

const LADDER: readonly EffortLevel[] = [...THINKING_LEVELS, "max"]

const DESCRIPTIONS: Record<EffortLevel, string> = {
  off: "no extended reasoning",
  minimal: "fastest, minimal reasoning",
  low: "light reasoning for simple tasks",
  medium: "balanced reasoning for everyday work",
  high: "deep reasoning for hard problems",
  xhigh: "the model's highest reasoning level",
  max: "xhigh plus the thinking budget forced to its configured ceiling"
}

export function registerEffort(pi: ExtensionAPI, config: EffortConfig): void {
  let maxActive = false
  let applying = false

  const currentLevel = (): EffortLevel => {
    const level = asThinking(pi.getThinkingLevel()) ?? "medium"
    return maxActive && level === "xhigh" ? "max" : level
  }

  const summary = (): string => {
    const active = currentLevel()
    const lines = [`reasoning effort: ${active} (${DESCRIPTIONS[active]})`, ""]
    for (const level of LADDER) {
      const marker = level === active ? "›" : " "
      lines.push(`${marker} ${level.padEnd(7)} ${DESCRIPTIONS[level]}`)
    }
    lines.push("")
    lines.push(`Usage: /effort <level>, /effort up, /effort down. max raises token-budget providers to ${config.maxBudgetTokens} thinking tokens.`)
    return lines.join("\n")
  }

  const apply = (target: EffortLevel): boolean => {
    const thinking: ThinkingLevel = target === "max" ? "xhigh" : target
    applying = true
    try {
      pi.setThinkingLevel(thinking)
    } catch {
      return false
    } finally {
      applying = false
    }
    if (asThinking(pi.getThinkingLevel()) !== thinking) return false
    maxActive = target === "max"
    return true
  }

  pi.on("thinking_level_select", () => {
    if (!applying) maxActive = false
  })

  pi.on("before_provider_request", (event) => {
    if (!maxActive || !isRecord(event.payload)) return undefined
    const body = event.payload
    const next: Record<string, unknown> = { ...body }
    let changed = false
    if (isRecord(body.thinking) && typeof body.thinking.budget_tokens === "number") {
      const budget = Math.max(body.thinking.budget_tokens, config.maxBudgetTokens)
      if (budget !== body.thinking.budget_tokens) {
        next.thinking = { ...body.thinking, budget_tokens: budget }
        if (typeof body.max_tokens === "number" && body.max_tokens <= budget) {
          next.max_tokens = budget + 8192
        }
        changed = true
      }
    }
    if (isRecord(body.generationConfig) && isRecord(body.generationConfig.thinkingConfig)) {
      const thinkingConfig = body.generationConfig.thinkingConfig
      if (typeof thinkingConfig.thinkingBudget === "number" && thinkingConfig.thinkingBudget >= 0 && thinkingConfig.thinkingBudget < config.maxBudgetTokens) {
        next.generationConfig = {
          ...body.generationConfig,
          thinkingConfig: { ...thinkingConfig, thinkingBudget: config.maxBudgetTokens }
        }
        changed = true
      }
    }
    return changed ? next : undefined
  })

  pi.registerCommand("effort", {
    description: "Show or set the model's reasoning effort (off | minimal | low | medium | high | xhigh | max, or up/down to step); max sits above xhigh and forces the provider's thinking budget to its ceiling",
    getArgumentCompletions: (prefix: string): Array<{ value: string; label: string }> | null => {
      const needle = prefix.trim().toLowerCase()
      const items = [
        ...LADDER.map((level) => ({ value: level as string, label: `${level} — ${DESCRIPTIONS[level]}` })),
        { value: "up", label: "up — step the effort one level higher" },
        { value: "down", label: "down — step the effort one level lower" }
      ].filter((item) => item.value.startsWith(needle))
      return items.length > 0 ? items : null
    },
    handler: async (args, ctx) => {
      const requested = (args ?? "").trim().toLowerCase()
      const notify = (text: string, level: "info" | "error"): void => {
        if (ctx.hasUI) ctx.ui.notify(text, level)
      }
      if (requested === "") {
        notify(summary(), "info")
        return
      }
      let target: EffortLevel | undefined
      if (requested === "up" || requested === "down") {
        const index = LADDER.indexOf(currentLevel())
        const next = requested === "up" ? Math.min(LADDER.length - 1, index + 1) : Math.max(0, index - 1)
        if (next === index) {
          notify(`effort: already at ${LADDER[index]} (${requested === "up" ? "maximum" : "minimum"})`, "info")
          return
        }
        target = LADDER[next]
      } else if (requested === "max") {
        target = "max"
      } else {
        target = asThinking(requested)
      }
      if (target === undefined) {
        notify(`effort: unknown level "${requested}" (valid: ${LADDER.join(", ")}, up, down)`, "error")
        return
      }
      if (!apply(target)) {
        notify(`effort: the current model does not accept thinking level ${target === "max" ? "xhigh" : target}`, "error")
        return
      }
      notify(`effort: ${target} (${DESCRIPTIONS[target]})`, "info")
    }
  })
}
