import type { JobSnapshot } from "./index.ts";

const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const CONTROL = /\x1b[@-Z\\-_]/g;

export interface TruncateOptions {
  maxBytes: number;
  maxLines: number;
}

export interface TruncateResult {
  content: string;
  truncated?: boolean;
  totalLines?: number;
  totalBytes?: number;
}

export type TruncateFn = (text: string, options: TruncateOptions) => TruncateResult;

export class Renderer {
  constructor(private readonly truncate: TruncateFn) {}

  static clip(text: string, max: number): string {
    if (max <= 0) {
      return "";
    }

    if (text.length <= max) {
      return text;
    }

    if (max === 1) {
      return "…";
    }

    return `${text.slice(0, max - 1)}…`;
  }

  static normalize(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  static formatRuntime(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");

    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  static describeEnd(job: JobSnapshot): string {
    if (job.status === "done") {
      return "completed successfully (exit 0)";
    }

    if (job.status === "killed") {
      return `was killed${job.exitSignal !== null ? ` (${job.exitSignal})` : ""}`;
    }

    if (job.exitCode !== null) {
      return `failed (exit ${job.exitCode})`;
    }

    return `failed${job.exitSignal !== null ? ` (signal ${job.exitSignal})` : ""}`;
  }

  static cleanOutput(raw: string): string {
    const stripped = raw.replace(ANSI_CSI, "").replace(OSC, "").replace(CONTROL, "");

    if (!stripped.includes("\r")) {
      return stripped;
    }

    return stripped
      .split("\n")
      .map((line) => {
        const body = line.endsWith("\r") ? line.slice(0, -1) : line;
        const at = body.lastIndexOf("\r");

        return at === -1 ? body : body.slice(at + 1);
      })
      .join("\n");
  }

  renderJobs(jobs: JobSnapshot[], now: number, limit: number): string[] {
    const running = jobs.filter((job) => job.status === "running");

    if (running.length === 0) {
      return [];
    }

    const cap = Math.max(1, Math.floor(limit));
    const lines = running.slice(0, cap).map((job) => {
      const runtime = Renderer.formatRuntime(now - job.startedAt);
      const last = job.lastLine === "" ? "" : ` · ${Renderer.clip(Renderer.normalize(job.lastLine), 60)}`;

      return `▶ ${job.id} ${runtime} ${Renderer.clip(Renderer.normalize(job.command), 40)}${last}`;
    });

    if (running.length > cap) {
      lines.push(`… ${running.length - cap} more running`);
    }

    return lines;
  }

  formatJobList(jobs: JobSnapshot[], now: number): string {
    if (jobs.length === 0) {
      return "No jobs.";
    }

    const lines = jobs.map((job) => {
      const runtime = Renderer.formatRuntime((job.endedAt ?? now) - job.startedAt);
      const exit =
        job.status === "running" ? "-" : job.exitCode !== null ? String(job.exitCode) : (job.exitSignal ?? "?");
      const kind = job.background ? "bg" : "fg";

      return `${job.id}  ${job.status}  ${kind}  ${runtime}  exit:${exit}  ${Renderer.clip(Renderer.normalize(job.command), 80)}`;
    });

    return lines.join("\n");
  }

  renderOutput(raw: string, spillPath: string | null, maxBytes: number, maxLines: number): string {
    const trunc = this.truncate(Renderer.cleanOutput(raw), { maxBytes, maxLines });

    if (trunc.content.trim() === "") {
      return "(no output)";
    }

    if (trunc.truncated === true) {
      const where = spillPath !== null ? `; full output: ${spillPath}` : "";

      return `[output truncated: showing the tail of ${trunc.totalLines} lines / ${trunc.totalBytes} bytes${where}]\n${trunc.content}`;
    }

    return trunc.content;
  }

  tailBody(raw: string, maxBytes: number, maxLines: number, empty: string): string {
    const trunc = this.truncate(Renderer.cleanOutput(raw), { maxBytes, maxLines });

    return trunc.content.trim() === "" ? empty : trunc.content;
  }
}
