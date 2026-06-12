import { basename } from "node:path";

export type SegmentId =
  | "model"
  | "mode"
  | "role"
  | "git"
  | "context"
  | "usage"
  | "todos"
  | "cwd"
  | "clock";

export const SEGMENT_IDS: readonly SegmentId[] = [
  "model",
  "mode",
  "role",
  "git",
  "context",
  "usage",
  "todos",
  "cwd",
  "clock"
];

export interface SegmentToggle {
  enabled: boolean;
}

export interface StatuslineConfig {
  order: SegmentId[];
  separator: string;
  segments: Record<SegmentId, SegmentToggle>;
  gitIntervalMs: number;
  gitTimeoutMs: number;
  refreshMs: number;
  warnPercent: number;
  errorPercent: number;
}

export interface UsageSnapshot {
  input: number;
  output: number;
  cost: number | null;
}

export interface GitInfo {
  branch: string;
  dirty: boolean;
}

export interface SegmentPart {
  id: SegmentId;
  text: string;
  token: string | null;
}

export interface SegmentInputs {
  modelId: string | null;
  contextPercent: number | null;
  cwd: string;
  git: GitInfo | null;
  state: SegmentState;
  warnPercent: number;
  errorPercent: number;
  now: Date;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class SegmentState {
  mode: string | null = null;
  role: string | null = null;
  usage: UsageSnapshot | null = null;
  todosOpen: number | null = null;

  applyMode(payload: unknown): void {
    const record = asRecord(payload);
    const mode = record ? asString(record.mode) : null;
    if (mode) this.mode = mode;
  }

  applyRole(payload: unknown): void {
    const record = asRecord(payload);
    const role = record ? asString(record.role) : null;
    if (role) this.role = role;
  }

  applyUsage(payload: unknown): void {
    const record = asRecord(payload);
    if (!record) return;
    const input = asNumber(record.input);
    const output = asNumber(record.output);
    if (input === null && output === null) return;
    this.usage = {
      input: Math.max(0, input ?? 0),
      output: Math.max(0, output ?? 0),
      cost: asNumber(record.cost)
    };
  }

  applyTodos(payload: unknown): void {
    const record = asRecord(payload);
    if (!record) return;
    const open = asNumber(record.open);
    if (open !== null && open >= 0) this.todosOpen = Math.floor(open);
  }
}

export type GitExec = (
  command: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stdout: string; code: number }>;

export class GitWatcher {
  #exec: GitExec;
  #intervalMs: number;
  #timeoutMs: number;
  #info: GitInfo | null = null;
  #cwd: string | null = null;
  #fetchedAt = 0;
  #inFlight = false;

  constructor(exec: GitExec, intervalMs: number, timeoutMs: number) {
    this.#exec = exec;
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
  }

  current(): GitInfo | null {
    return this.#info;
  }

  poll(cwd: string, onChange: () => void): void {
    if (this.#inFlight) return;
    const now = Date.now();
    if (cwd === this.#cwd && now - this.#fetchedAt < this.#intervalMs) return;
    this.#inFlight = true;
    this.#refresh(cwd)
      .then(next => {
        this.#finish(cwd);
        const previous = this.#info;
        const changed =
          (next === null) !== (previous === null) ||
          (next !== null &&
            previous !== null &&
            (next.branch !== previous.branch || next.dirty !== previous.dirty));
        this.#info = next;
        if (changed) onChange();
      })
      .catch(() => {
        this.#finish(cwd);
      });
  }

  #finish(cwd: string): void {
    this.#cwd = cwd;
    this.#fetchedAt = Date.now();
    this.#inFlight = false;
  }

  async #refresh(cwd: string): Promise<GitInfo | null> {
    const head = await this.#exec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: this.#timeoutMs
    });
    if (head.code !== 0) return null;
    let branch = head.stdout.trim();
    if (branch === "") return null;
    if (branch === "HEAD") {
      const sha = await this.#exec("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
        timeout: this.#timeoutMs
      });
      branch = sha.code === 0 && sha.stdout.trim() !== "" ? `@${sha.stdout.trim()}` : "@detached";
    }
    const status = await this.#exec("git", ["-C", cwd, "status", "--porcelain"], {
      timeout: this.#timeoutMs
    });
    const dirty = status.code === 0 && status.stdout.trim() !== "";
    return { branch, dirty };
  }
}

function trimmed(value: number): string {
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

export function formatTokens(count: number): string {
  const n = Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return `${trimmed(n / 1000)}k`;
  if (n < 1000000000) return `${trimmed(n / 1000000)}M`;
  return `${trimmed(n / 1000000000)}B`;
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost < 0) return "0.00";
  if (cost >= 100) return cost.toFixed(0);
  if (cost >= 10) return cost.toFixed(1);
  return cost.toFixed(2);
}

function computePart(id: SegmentId, inputs: SegmentInputs): SegmentPart | null {
  switch (id) {
    case "model":
      return inputs.modelId ? { id, text: inputs.modelId, token: "accent" } : null;
    case "mode":
      return inputs.state.mode ? { id, text: inputs.state.mode, token: null } : null;
    case "role":
      return inputs.state.role ? { id, text: inputs.state.role, token: null } : null;
    case "git": {
      const info = inputs.git;
      if (!info) return null;
      return { id, text: `⎇ ${info.branch}${info.dirty ? "*" : ""}`, token: null };
    }
    case "context": {
      const pct = inputs.contextPercent;
      if (pct === null) return null;
      const shown = Math.min(999, Math.max(0, Math.round(pct)));
      const token = pct > inputs.errorPercent ? "error" : pct > inputs.warnPercent ? "warning" : null;
      return { id, text: `ctx ${shown}%`, token };
    }
    case "usage": {
      const usage = inputs.state.usage;
      if (!usage) return null;
      let text = `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`;
      if (usage.cost !== null) text += ` $${formatCost(usage.cost)}`;
      return { id, text, token: null };
    }
    case "todos": {
      const open = inputs.state.todosOpen;
      return open !== null && open > 0 ? { id, text: `todos ${open}`, token: null } : null;
    }
    case "cwd": {
      const name = basename(inputs.cwd);
      return { id, text: name === "" ? inputs.cwd : name, token: null };
    }
    case "clock": {
      const hh = String(inputs.now.getHours()).padStart(2, "0");
      const mm = String(inputs.now.getMinutes()).padStart(2, "0");
      return { id, text: `${hh}:${mm}`, token: null };
    }
    default:
      return null;
  }
}

export function computeSegments(
  order: SegmentId[],
  toggles: Record<SegmentId, SegmentToggle>,
  inputs: SegmentInputs
): SegmentPart[] {
  const parts: SegmentPart[] = [];
  for (const id of order) {
    if (!toggles[id]?.enabled) continue;
    const part = computePart(id, inputs);
    if (part) parts.push(part);
  }
  return parts;
}
