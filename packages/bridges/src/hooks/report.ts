import type { History, HooksConfig } from "./index.ts"
import type { MonitorStatus } from "./monitors.ts"
import { EVENT_MAPPING, HOOK_EVENTS, type LoadedHooks } from "./schema.ts"

const RECENT_LIMIT = 15

export interface Report {
  text: string
  hasProblems: boolean
}

export class Reporter {
  buildReport(
    loaded: LoadedHooks,
    statuses: MonitorStatus[],
    history: History,
    config: HooksConfig,
    configPaths: string[],
  ): Report {
    const lines: string[] = []
    lines.push("Hook event mapping (Claude name -> pi event):")

    for (const name of HOOK_EVENTS) {
      lines.push("  " + name + " -> " + EVENT_MAPPING[name])
    }

    lines.push("")
    lines.push("Config files (merged, project appended):")

    if (loaded.sources.length === 0) {
      lines.push("  none found (looked for " + configPaths.join(" and ") + ")")
    } else {
      for (const source of loaded.sources) {
        lines.push("  " + source)
      }
    }

    lines.push("")
    lines.push("Hooks loaded (" + loaded.totalHooks + "):")
    let anyHooks = false

    for (const name of HOOK_EVENTS) {
      const groups = loaded.events[name]

      if (groups.length === 0) {
        continue
      }

      anyHooks = true
      lines.push("  " + name + ":")

      for (const group of groups) {
        const matcher = group.matcherSource.length > 0 ? group.matcherSource : "*"

        for (const hook of group.hooks) {
          lines.push("    [" + matcher + "] " + hook.command + " (timeout " + hook.timeoutMs / 1000 + "s)")
        }
      }
    }

    if (!anyHooks) {
      lines.push("  none")
    }

    const problems = [...loaded.problems, ...config.problems]
    lines.push("")
    lines.push("Validation problems (" + problems.length + "):")

    if (problems.length === 0) {
      lines.push("  none")
    }

    for (const problem of problems) {
      lines.push("  " + problem)
    }

    lines.push("")
    lines.push("Monitors (" + statuses.length + "):")

    if (statuses.length === 0) {
      lines.push("  none configured")
    }

    for (const status of statuses) {
      const pid = status.pid !== null ? " pid " + status.pid : ""
      const last = status.lastExit.length > 0 ? ", last exit " + status.lastExit : ""
      const tail = status.stderrTail.length > 0 ? " | stderr: " + status.stderrTail : ""
      lines.push("  " + status.name + ": " + status.state + pid + ", restarts " + status.restarts + last + tail)
    }

    lines.push("")
    const records = history.list().slice(-RECENT_LIMIT).reverse()
    lines.push("Recent dispatches (newest first, keeping last " + config.historySize + "):")

    if (records.length === 0) {
      lines.push("  none yet")
    }

    for (const record of records) {
      const exit = record.exitCode === null ? "-" : String(record.exitCode)
      const detail = record.detail.length > 0 ? " | " + record.detail : ""
      lines.push(
        "  " +
          record.at.slice(11, 19) +
          " " +
          record.event +
          " " +
          record.outcome +
          " exit " +
          exit +
          " " +
          record.durationMs +
          "ms " +
          record.command +
          detail,
      )
    }

    lines.push("")
    lines.push(
      "Hook timeout field is in seconds (Claude-compatible); default " +
        config.defaultTimeoutMs / 1000 +
        "s per hook, " +
        config.eventBudgetMs / 1000 +
        "s budget per event. Exit 0 continues (stdout becomes context on UserPromptSubmit), exit 2 blocks with stderr as reason, other codes are logged.",
    )

    return { text: lines.join("\n"), hasProblems: problems.length > 0 }
  }

  reloadSummary(loaded: LoadedHooks): { text: string; hasProblems: boolean } {
    const text =
      "hooks reloaded: " +
      loaded.totalHooks +
      " hook(s) from " +
      loaded.sources.length +
      " file(s)" +
      (loaded.problems.length > 0 ? ", " + loaded.problems.length + " problem(s)" : "")

    return { text, hasProblems: loaded.problems.length > 0 }
  }
}
