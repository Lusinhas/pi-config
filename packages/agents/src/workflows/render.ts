import type { RunRecord } from "./types.ts"

export interface ThemeLike {
  fg?: (color: never, text: string) => string
}

export interface StateGlyph {
  mark: string
  color: string
}

export class ViewerRenderer {
  static paint(theme: ThemeLike | undefined, color: string, text: string): string {
    if (!theme || typeof theme.fg !== "function") {
      return text
    }

    try {
      return theme.fg(color as never, text)
    } catch {
      return text
    }
  }

  static glyph(state: RunRecord["state"]): StateGlyph {
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

  static elapsed(record: RunRecord, now: number): string {
    const end = record.endedAt ?? now
    const total = Math.max(0, Math.floor((end - record.startedAt) / 1000))

    if (total < 60) {
      return `${total}s`
    }

    const minutes = Math.floor(total / 60)

    if (minutes < 60) {
      return `${minutes}m${total % 60}s`
    }

    return `${Math.floor(minutes / 60)}h${minutes % 60}m`
  }

  static phaseSummary(record: RunRecord): string {
    return record.phases
      .filter((phase) => phase.agents > 0)
      .map((phase) => `${phase.title}(${phase.agents})`)
      .join(" ")
  }

  static runLine(record: RunRecord, now: number): string {
    const phases = ViewerRenderer.phaseSummary(record)
    const background = record.background === true ? " · background" : ""

    return `${record.name} ${record.id} · ${record.agentCount} agents · ${record.tokens} tokens · ${ViewerRenderer.elapsed(record, now)}${background}${phases !== "" ? ` · ${phases}` : ""}`
  }
}
