import type { CommentsConfig, Mode } from "./config.ts";
import type { CheckResult } from "./index.ts";
import type { Finding } from "./patterns.ts";

export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  block: "slop comments block the write/edit until rewritten",
  warn: "slop comments pass but trigger a follow-up notice",
  off: "comment policing disabled",
};

export interface ReportState {
  mode: Mode;
  history: readonly CheckResult[];
}

export class TextFormatter {
  formatFindings(findings: readonly Finding[], max: number): string {
    const cap = Math.max(1, Math.floor(max));
    const shown = findings.slice(0, cap);
    const lines = shown.map(
      (finding, index) =>
        `${index + 1}. [${finding.rule}] line ${finding.line}: ${this.clip(finding.text)} (${finding.message})`,
    );
    const hidden = findings.length - shown.length;

    if (hidden > 0) {
      lines.push(`… ${hidden} more finding${hidden === 1 ? "" : "s"} not shown`);
    }

    return lines.join("\n");
  }

  private clip(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();

    if (flat.length <= 160) {
      return flat;
    }

    return `${flat.slice(0, 159)}…`;
  }
}

export class Reporter {
  private readonly formatter = new TextFormatter();

  formatFindings(findings: readonly Finding[], max: number): string {
    return this.formatter.formatFindings(findings, max);
  }

  blockReason(result: CheckResult, config: CommentsConfig): string {
    const count = result.findings.length;

    return [
      `comments: blocked ${result.tool} to ${result.path} — ${count} low-value comment finding${count === 1 ? "" : "s"} (line numbers refer to the new content):`,
      this.formatFindings(result.findings, config.maxFindings),
      `Retry the ${result.tool} with these comments removed or rewritten to explain why rather than what. To intentionally keep one, include ${config.allowMarker} in that comment line.`,
    ].join("\n");
  }

  warnNotice(result: CheckResult, config: CommentsConfig): string {
    const count = result.findings.length;

    return [
      `comments: found ${count} low-value comment finding${count === 1 ? "" : "s"} in ${result.path} (warn mode, change was applied; line numbers refer to the new content):`,
      this.formatFindings(result.findings, config.maxFindings),
      `Please remove or rewrite them; include ${config.allowMarker} in any comment that should stay.`,
    ].join("\n");
  }

  warnKey(result: CheckResult): string {
    return `${result.path}|${result.findings.map((finding) => `${finding.rule}:${finding.text}`).join("|")}`;
  }

  buildReport(state: ReportState, config: CommentsConfig): string {
    const lines = [`mode: ${state.mode} (${MODE_DESCRIPTIONS[state.mode]})`];
    const active = (Object.entries(config.detectors) as Array<[string, boolean]>)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    lines.push(`detectors: ${active.length > 0 ? active.join(", ") : "(none)"}`);
    lines.push(`allow marker: ${config.allowMarker}`);
    lines.push(`ignore globs: ${config.ignore.length}`);
    lines.push(`max findings reported: ${config.maxFindings}`);

    if (state.history.length === 0) {
      lines.push("last findings: (none this session)");
    } else {
      const latest = state.history[0];
      lines.push(
        `last findings: ${latest.findings.length} in ${latest.path} via ${latest.tool}; run /comments last for details`,
      );
    }

    return lines.join("\n");
  }

  buildHistory(state: ReportState, config: CommentsConfig): string {
    if (state.history.length === 0) {
      return "comments: no findings recorded this session.";
    }

    const sections = state.history.map((result, index) =>
      [
        `${index + 1}) ${result.path} (${result.tool}, ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}):`,
        this.formatFindings(result.findings, config.maxFindings),
      ].join("\n"),
    );

    return sections.join("\n\n");
  }
}
