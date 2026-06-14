import type { Runner, TaskRecord, TranscriptEntry } from "./index.ts"

export type Painter = (color: string, text: string) => string

export type Truncate = (text: string, width: number) => string

const DETAIL_HEIGHT = 18

export type ViewerKey = "up" | "down" | "enter" | "escape" | "quit" | "kill" | "none"

export interface ViewerAction {
  close: boolean
  kill?: string
}

export function formatElapsedSeconds(total: number): string {
  if (total < 60) {
    return `${total}s`
  }

  const minutes = Math.floor(total / 60)

  if (minutes < 60) {
    return `${minutes}m${total % 60}s`
  }

  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

export function elapsed(record: TaskRecord, now: number = Date.now()): string {
  const end = record.endedAt ?? now
  const total = Math.max(0, Math.floor((end - record.startedAt) / 1000))

  return formatElapsedSeconds(total)
}

export function glyph(state: TaskRecord["state"]): { mark: string; color: string } {
  if (state === "running") {
    return { mark: "▶", color: "accent" }
  }

  if (state === "done") {
    return { mark: "✓", color: "success" }
  }

  if (state === "aborted") {
    return { mark: "■", color: "warning" }
  }

  return { mark: "✗", color: "error" }
}

export function taskLine(record: TaskRecord, now: number = Date.now()): string {
  const via = record.via !== "" ? ` (${record.via})` : ""
  const turns = record.turns > 0 ? ` · turn ${record.turns}` : ""

  return `${record.agent}${via} #${record.id}${turns} · ${elapsed(record, now)} · ${record.activity}`
}

export function widgetLines(tasks: TaskRecord[], limit: number, paint: Painter, now: number = Date.now()): string[] {
  const running = tasks.filter((record) => record.state === "running")

  if (running.length === 0) {
    return []
  }

  const visible = running.slice(0, Math.max(1, limit))
  const lines = visible.map((record) => {
    const mark = glyph(record.state)

    return `${paint(mark.color, mark.mark)} ${taskLine(record, now)}`
  })

  if (running.length > visible.length) {
    lines.push(paint("dim", `… ${running.length - visible.length} more running (/agents view)`))
  }

  return lines
}

export function taskReport(tasks: TaskRecord[], now: number = Date.now()): string {
  if (tasks.length === 0) {
    return "No subagent tasks have run in this session."
  }

  const lines = [`Subagent tasks (${tasks.filter((record) => record.state === "running").length} running, ${tasks.length} total):`]

  for (const record of tasks) {
    lines.push(`${glyph(record.state).mark} [${record.state}] ${taskLine(record, now)}`)
  }

  return lines.join("\n")
}

export function transcriptLines(entries: readonly TranscriptEntry[], paint: Painter, truncate: Truncate, width: number): string[] {
  const lines: string[] = []

  for (const entry of entries) {
    const stamp = new Date(entry.at).toISOString().slice(11, 19)
    const tag = entry.kind === "tool" ? paint("warning", "tool") : entry.kind === "info" ? paint("dim", "info") : paint("accent", "text")
    const body = entry.text.split("\n")
    lines.push(truncate(`${paint("dim", stamp)} ${tag} ${body[0] ?? ""}`, width))

    for (const continuation of body.slice(1, 12)) {
      lines.push(truncate(`              ${continuation}`, width))
    }

    if (body.length > 12) {
      lines.push(paint("dim", `              … ${body.length - 12} more lines`))
    }
  }

  return lines
}

export class ViewerModel {
  private readonly runner: Runner
  private view: "list" | "detail" = "list"
  private index = 0
  private scroll = 0

  constructor(runner: Runner) {
    this.runner = runner
  }

  private selected(tasks: TaskRecord[]): TaskRecord | undefined {
    return tasks[this.index]
  }

  render(width: number, paint: Painter, truncate: Truncate, now: number = Date.now()): string[] {
    const tasks = this.runner.listTasks()

    if (this.index >= tasks.length) {
      this.index = Math.max(0, tasks.length - 1)
    }

    const lines: string[] = []
    lines.push("")

    if (this.view === "list") {
      lines.push(paint("accent", `Subagent tasks — ${tasks.filter((record) => record.state === "running").length} running, ${tasks.length} total`))
      lines.push("")

      if (tasks.length === 0) {
        lines.push(paint("dim", "No subagent tasks have run in this session."))
      }

      tasks.forEach((record, position) => {
        const mark = glyph(record.state)
        const row = `${paint(mark.color, mark.mark)} ${taskLine(record, now)}`
        const pointer = position === this.index ? paint("accent", "› ") : "  "
        lines.push(truncate(`${pointer}${row}`, width))
      })
      lines.push("")
      lines.push(paint("dim", "↑/↓ select · enter transcript · x kill · q close"))
      lines.push("")

      return lines
    }

    const record = this.selected(tasks)

    if (!record) {
      this.view = "list"

      return [paint("dim", "task disappeared; press any key")]
    }

    const mark = glyph(record.state)
    lines.push(paint("accent", `${mark.mark} ${record.agent} #${record.id} [${record.state}]`) + paint("dim", ` · ${record.turns} turns · ${record.tokens} tokens · ${elapsed(record, now)}`))
    lines.push("")
    const body = transcriptLines(record.transcript, paint, truncate, width)
    const maxScroll = Math.max(0, body.length - DETAIL_HEIGHT)

    if (this.scroll > maxScroll) {
      this.scroll = maxScroll
    }

    const start = Math.max(0, body.length - DETAIL_HEIGHT - this.scroll)
    lines.push(...body.slice(start, start + DETAIL_HEIGHT))

    if (start > 0) {
      lines.push(paint("dim", `… ${start} earlier lines (↑ to scroll)`))
    }

    lines.push("")
    lines.push(paint("dim", "↑/↓ scroll · esc back · x kill · q close"))
    lines.push("")

    return lines
  }

  handleKey(key: ViewerKey): ViewerAction {
    const tasks = this.runner.listTasks()

    if (key === "escape") {
      if (this.view === "detail") {
        this.view = "list"
        this.scroll = 0

        return { close: false }
      }

      return { close: true }
    }

    if (key === "quit") {
      return { close: true }
    }

    if (key === "up") {
      if (this.view === "list") {
        this.index = Math.max(0, this.index - 1)
      } else {
        this.scroll += 1
      }

      return { close: false }
    }

    if (key === "down") {
      if (this.view === "list") {
        this.index = Math.min(Math.max(0, tasks.length - 1), this.index + 1)
      } else {
        this.scroll = Math.max(0, this.scroll - 1)
      }

      return { close: false }
    }

    if (key === "enter" && this.view === "list" && tasks.length > 0) {
      this.view = "detail"
      this.scroll = 0

      return { close: false }
    }

    if (key === "kill") {
      const record = this.selected(tasks)

      if (record) {
        return { close: false, kill: record.id }
      }
    }

    return { close: false }
  }
}
