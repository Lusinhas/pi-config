import { basename } from "node:path";
import { Format } from "./format.ts";

export type SegmentId =
  | "model"
  | "mode"
  | "role"
  | "git"
  | "context"
  | "ide"
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
  "ide",
  "usage",
  "todos",
  "cwd",
  "clock"
];

const SEGMENT_INDEX: ReadonlyMap<SegmentId, number> = new Map(
  SEGMENT_IDS.map((id, index) => [id, index])
);

export function isSegmentId(value: unknown): value is SegmentId {
  return typeof value === "string" && SEGMENT_INDEX.has(value as SegmentId);
}

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

export interface IdeInfo {
  connected: boolean | null;
  activeFile: string | null;
  selectedLines: number;
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
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
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

function usageChanged(previous: UsageSnapshot | null, next: UsageSnapshot): boolean {
  if (previous === null) {
    return true;
  }

  return (
    previous.input !== next.input ||
    previous.output !== next.output ||
    previous.cost !== next.cost
  );
}

export class SegmentState {
  mode: string | null = null;
  role: string | null = null;
  usage: UsageSnapshot | null = null;
  todosOpen: number | null = null;
  ide: IdeInfo | null = null;

  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  applyMode(payload: unknown): void {
    const record = asRecord(payload);
    const mode = record ? asString(record.mode) : null;

    if (mode !== null && mode !== this.mode) {
      this.mode = mode;
      this.#bump();
    }
  }

  applyRole(payload: unknown): void {
    const record = asRecord(payload);
    const role = record ? asString(record.role) : null;

    if (role !== null && role !== this.role) {
      this.role = role;
      this.#bump();
    }
  }

  applyUsage(payload: unknown): void {
    const record = asRecord(payload);

    if (!record) {
      return;
    }

    const input = asNumber(record.input);
    const output = asNumber(record.output);

    if (input === null && output === null) {
      return;
    }

    const next: UsageSnapshot = {
      input: Math.max(0, input ?? 0),
      output: Math.max(0, output ?? 0),
      cost: asNumber(record.cost)
    };

    if (usageChanged(this.usage, next)) {
      this.usage = next;
      this.#bump();
    }
  }

  applyTodos(payload: unknown): void {
    const record = asRecord(payload);

    if (!record) {
      return;
    }

    const open = asNumber(record.open);

    if (open !== null && open >= 0) {
      const floored = Math.floor(open);

      if (floored !== this.todosOpen) {
        this.todosOpen = floored;
        this.#bump();
      }
    }
  }

  applyIde(payload: unknown): void {
    const record = asRecord(payload);

    if (!record) {
      return;
    }

    if (record.clear === true) {
      if (this.ide !== null) {
        this.ide = null;
        this.#bump();
      }

      return;
    }

    const connected = record.connected === true ? true : record.connected === false ? false : null;
    const selectedLines = asNumber(record.selectedLines);

    this.ide = {
      connected,
      activeFile: asString(record.activeFile),
      selectedLines: selectedLines !== null && selectedLines > 0 ? Math.floor(selectedLines) : 0
    };
    this.#bump();
  }

  #bump(): void {
    this.#revision += 1;
  }
}

export class Compute {
  static part(id: SegmentId, inputs: SegmentInputs): SegmentPart | null {
    switch (id) {
      case "model":
        return inputs.modelId ? { id, text: inputs.modelId, token: "accent" } : null;

      case "mode":
        return inputs.state.mode ? { id, text: inputs.state.mode, token: null } : null;

      case "role":
        return inputs.state.role ? { id, text: inputs.state.role, token: "muted" } : null;

      case "git": {
        const info = inputs.git;

        if (!info) {
          return null;
        }

        const token = info.dirty ? "warning" : "success";

        return { id, text: `⎇ ${info.branch}${info.dirty ? "*" : ""}`, token };
      }

      case "context": {
        const pct = inputs.contextPercent;

        if (pct === null) {
          return null;
        }

        const shown = Math.min(999, Math.max(0, Math.round(pct)));
        const token =
          pct > inputs.errorPercent ? "error" : pct > inputs.warnPercent ? "warning" : "dim";

        return { id, text: `ctx ${shown}%`, token };
      }

      case "ide": {
        const ide = inputs.state.ide;

        if (!ide) {
          return null;
        }

        const token = ide.connected === false ? "error" : ide.connected === true ? "accent" : "dim";

        return { id, text: Format.ide(ide), token };
      }

      case "usage": {
        const usage = inputs.state.usage;

        if (!usage) {
          return null;
        }

        let text = `↑${Format.tokens(usage.input)} ↓${Format.tokens(usage.output)}`;

        if (usage.cost !== null) {
          text += ` $${Format.cost(usage.cost)}`;
        }

        return { id, text, token: "dim" };
      }

      case "todos": {
        const open = inputs.state.todosOpen;

        return open !== null && open > 0 ? { id, text: `todos ${open}`, token: "muted" } : null;
      }

      case "cwd": {
        const name = basename(inputs.cwd);

        return { id, text: name === "" ? inputs.cwd : name, token: "muted" };
      }

      case "clock": {
        const hh = String(inputs.now.getHours()).padStart(2, "0");
        const mm = String(inputs.now.getMinutes()).padStart(2, "0");

        return { id, text: `${hh}:${mm}`, token: "dim" };
      }

      default:
        return null;
    }
  }
}

export function computeSegments(
  order: SegmentId[],
  toggles: Record<SegmentId, SegmentToggle>,
  inputs: SegmentInputs
): SegmentPart[] {
  const parts: SegmentPart[] = [];

  for (const id of order) {
    if (!toggles[id]?.enabled) {
      continue;
    }

    const part = Compute.part(id, inputs);

    if (part) {
      parts.push(part);
    }
  }

  return parts;
}
