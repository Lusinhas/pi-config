import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { Runner, TaskRecord, TranscriptEntry } from "./runner.ts"

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

function glyph(state: TaskRecord["state"]): { mark: string; color: string } {
  if (state === "running") return { mark: "▶", color: "accent" }
  if (state === "done") return { mark: "✓", color: "success" }
  if (state === "aborted") return { mark: "■", color: "warning" }
  return { mark: "✗", color: "error" }
}

function elapsed(record: TaskRecord): string {
  const end = record.endedAt ?? Date.now()
  const total = Math.max(0, Math.floor((end - record.startedAt) / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m${total % 60}s`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

function taskLine(record: TaskRecord): string {
  const via = record.via !== "" ? ` (${record.via})` : ""
  const turns = record.turns > 0 ? ` · turn ${record.turns}` : ""
  return `${record.agent}${via} #${record.id}${turns} · ${elapsed(record)} · ${record.activity}`
}

export function widgetLines(runner: Runner, limit: number, theme?: ThemeLike): string[] {
  const running = runner.listTasks().filter((record) => record.state === "running")
  if (running.length === 0) return []
  const visible = running.slice(0, Math.max(1, limit))
  const lines = visible.map((record) => {
    const mark = glyph(record.state)
    return `${paint(theme, mark.color, mark.mark)} ${taskLine(record)}`
  })
  if (running.length > visible.length) {
    lines.push(paint(theme, "dim", `… ${running.length - visible.length} more running (/agents view)`))
  }
  return lines
}

export function taskReport(runner: Runner): string {
  const tasks = runner.listTasks()
  if (tasks.length === 0) return "No subagent tasks have run in this session."
  const lines = [`Subagent tasks (${tasks.filter((record) => record.state === "running").length} running, ${tasks.length} total):`]
  for (const record of tasks) {
    lines.push(`${glyph(record.state).mark} [${record.state}] ${taskLine(record)}`)
  }
  return lines.join("\n")
}

function transcriptLines(entries: readonly TranscriptEntry[], theme: ThemeLike | undefined, width: number): string[] {
  const lines: string[] = []
  for (const entry of entries) {
    const stamp = new Date(entry.at).toISOString().slice(11, 19)
    const tag = entry.kind === "tool" ? paint(theme, "warning", "tool") : entry.kind === "info" ? paint(theme, "dim", "info") : paint(theme, "accent", "text")
    const body = entry.text.split("\n")
    lines.push(truncateToWidth(`${paint(theme, "dim", stamp)} ${tag} ${body[0] ?? ""}`, width))
    for (const continuation of body.slice(1, 12)) {
      lines.push(truncateToWidth(`              ${continuation}`, width))
    }
    if (body.length > 12) lines.push(paint(theme, "dim", `              … ${body.length - 12} more lines`))
  }
  return lines
}

export async function openViewer(ctx: ExtensionContext, runner: Runner): Promise<void> {
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
      const selected = (): TaskRecord | undefined => runner.listTasks()[index]
      return {
        render(width: number): string[] {
          const themed = theme as unknown as ThemeLike
          const tasks = runner.listTasks()
          if (index >= tasks.length) index = Math.max(0, tasks.length - 1)
          const lines: string[] = []
          lines.push("")
          if (view === "list") {
            lines.push(paint(themed, "accent", `Subagent tasks — ${tasks.filter((record) => record.state === "running").length} running, ${tasks.length} total`))
            lines.push("")
            if (tasks.length === 0) {
              lines.push(paint(themed, "dim", "No subagent tasks have run in this session."))
            }
            tasks.forEach((record, position) => {
              const mark = glyph(record.state)
              const row = `${paint(themed, mark.color, mark.mark)} ${taskLine(record)}`
              const pointer = position === index ? paint(themed, "accent", "› ") : "  "
              lines.push(truncateToWidth(`${pointer}${row}`, width))
            })
            lines.push("")
            lines.push(paint(themed, "dim", "↑/↓ select · enter transcript · x kill · q close"))
            lines.push("")
            return lines
          }
          const record = selected()
          if (!record) {
            view = "list"
            return [paint(themed, "dim", "task disappeared; press any key")]
          }
          const mark = glyph(record.state)
          lines.push(paint(themed, "accent", `${mark.mark} ${record.agent} #${record.id} [${record.state}]`) + paint(themed, "dim", ` · ${record.turns} turns · ${record.tokens} tokens · ${elapsed(record)}`))
          lines.push("")
          const body = transcriptLines(record.transcript, themed, width)
          const height = 18
          const maxScroll = Math.max(0, body.length - height)
          if (scroll > maxScroll) scroll = maxScroll
          const start = Math.max(0, body.length - height - scroll)
          lines.push(...body.slice(start, start + height))
          if (start > 0) lines.push(paint(themed, "dim", `… ${start} earlier lines (↑ to scroll)`))
          lines.push("")
          lines.push(paint(themed, "dim", "↑/↓ scroll · esc back · x kill · q close"))
          lines.push("")
          return lines
        },
        handleInput(data: string): void {
          const tasks = runner.listTasks()
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
            if (view === "list") index = Math.min(Math.max(0, tasks.length - 1), index + 1)
            else scroll = Math.max(0, scroll - 1)
            refresh()
            return
          }
          if (matchesKey(data, "enter") && view === "list" && tasks.length > 0) {
            view = "detail"
            scroll = 0
            refresh()
            return
          }
          if (data === "x") {
            const record = selected()
            if (record) {
              runner.killTask(record.id)
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
