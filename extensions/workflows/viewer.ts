import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { RunRecord, Workflows } from "./runs.ts"

export interface ThemeLike {
  fg?: (color: never, text: string) => string
}

function paint(theme: ThemeLike | undefined, color: string, text: string): string {
  if (!theme || typeof theme.fg !== "function") return text
  try {
    return theme.fg(color as never, text)
  } catch {
    return text
  }
}

function glyph(state: RunRecord["state"]): { mark: string; color: string } {
  if (state === "running") return { mark: "▶", color: "accent" }
  if (state === "done") return { mark: "✓", color: "success" }
  if (state === "aborted") return { mark: "■", color: "warning" }
  return { mark: "✗", color: "error" }
}

function elapsed(record: RunRecord): string {
  const end = record.endedAt ?? Date.now()
  const total = Math.max(0, Math.floor((end - record.startedAt) / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m${total % 60}s`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

function phaseSummary(record: RunRecord): string {
  return record.phases
    .filter((phase) => phase.agents > 0)
    .map((phase) => `${phase.title}(${phase.agents})`)
    .join(" ")
}

function runLine(record: RunRecord): string {
  const phases = phaseSummary(record)
  const background = record.background === true ? " · background" : ""
  return `${record.name} ${record.id} · ${record.agentCount} agents · ${record.tokens} tokens · ${elapsed(record)}${background}${phases !== "" ? ` · ${phases}` : ""}`
}

export async function openRunViewer(ctx: ExtensionContext, workflows: Workflows): Promise<void> {
  if (!ctx.hasUI) return
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => {
      let view: "list" | "detail" = "list"
      let index = 0
      let scroll = 0
      const refresh = (): void => {
        try {
          tui.requestRender()
        } catch {}
      }
      const ticker = setInterval(refresh, 1000)
      const selected = (): RunRecord | undefined => workflows.listRuns()[index]
      return {
        render(width: number): string[] {
          const themed = theme as unknown as ThemeLike
          const runs = workflows.listRuns()
          if (index >= runs.length) index = Math.max(0, runs.length - 1)
          const lines: string[] = []
          lines.push("")
          if (view === "list") {
            lines.push(paint(themed, "accent", `Workflow runs — ${runs.filter((record) => record.state === "running").length} running, ${runs.length} total`))
            lines.push("")
            if (runs.length === 0) {
              lines.push(paint(themed, "dim", "No workflows have run in this session."))
            }
            runs.forEach((record, position) => {
              const mark = glyph(record.state)
              const row = `${paint(themed, mark.color, mark.mark)} ${runLine(record)}`
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
          const mark = glyph(record.state)
          lines.push(paint(themed, "accent", `${mark.mark} ${record.name} ${record.id} [${record.state}]`) + paint(themed, "dim", ` · ${record.agentCount} agents · ${record.tokens} tokens · ${elapsed(record)}`))
          const phases = phaseSummary(record)
          if (phases !== "") lines.push(paint(themed, "dim", `phases: ${phases}`))
          if (record.result !== undefined && record.result !== "") lines.push(truncateToWidth(paint(themed, "dim", `result: ${record.result}`), width))
          lines.push("")
          const body = record.logs.map((line) => truncateToWidth(line, width))
          const height = 18
          const maxScroll = Math.max(0, body.length - height)
          if (scroll > maxScroll) scroll = maxScroll
          const start = Math.max(0, body.length - height - scroll)
          if (body.length === 0) lines.push(paint(themed, "dim", "(no log lines were recorded)"))
          lines.push(...body.slice(start, start + height))
          if (start > 0) lines.push(paint(themed, "dim", `… ${start} earlier lines (↑ to scroll)`))
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
            if (view === "list") index = Math.max(0, index - 1)
            else scroll += 1
            refresh()
            return
          }
          if (matchesKey(data, "down")) {
            if (view === "list") index = Math.min(Math.max(0, runs.length - 1), index + 1)
            else scroll = Math.max(0, scroll - 1)
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
    }
  )
}
