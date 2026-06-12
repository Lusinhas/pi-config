import type { JobSnapshot } from "./manager";

export function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatRuntime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function renderJobs(jobs: JobSnapshot[], now: number, limit: number): string[] {
  const running = jobs.filter((job) => job.status === "running");
  if (running.length === 0) return [];
  const cap = Math.max(1, Math.floor(limit));
  const lines = running.slice(0, cap).map((job) => {
    const runtime = formatRuntime(now - job.startedAt);
    const last = job.lastLine === "" ? "" : ` · ${clip(normalize(job.lastLine), 60)}`;
    return `▶ ${job.id} ${runtime} ${clip(normalize(job.command), 40)}${last}`;
  });
  if (running.length > cap) lines.push(`… ${running.length - cap} more running`);
  return lines;
}

export function formatJobList(jobs: JobSnapshot[], now: number): string {
  if (jobs.length === 0) return "No jobs.";
  const lines = jobs.map((job) => {
    const runtime = formatRuntime((job.endedAt ?? now) - job.startedAt);
    const exit =
      job.status === "running" ? "-" : job.exitCode !== null ? String(job.exitCode) : (job.exitSignal ?? "?");
    const kind = job.background ? "bg" : "fg";
    return `${job.id}  ${job.status}  ${kind}  ${runtime}  exit:${exit}  ${clip(normalize(job.command), 80)}`;
  });
  return lines.join("\n");
}
