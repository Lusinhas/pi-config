import { readFileSync } from "node:fs";
import {
  SEGMENT_IDS,
  isSegmentId,
  type SegmentId,
  type SegmentToggle,
  type StatuslineConfig
} from "./index.ts";

export const FALLBACK: StatuslineConfig = {
  order: [...SEGMENT_IDS],
  separator: " │ ",
  segments: {
    model: { enabled: true },
    mode: { enabled: true },
    role: { enabled: true },
    git: { enabled: true },
    context: { enabled: true },
    ide: { enabled: true },
    usage: { enabled: true },
    todos: { enabled: true },
    cwd: { enabled: true },
    clock: { enabled: true }
  },
  gitIntervalMs: 5000,
  gitTimeoutMs: 3000,
  refreshMs: 30000,
  warnPercent: 80,
  errorPercent: 95
};

export class Guard {
  static positive(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  }

  static percent(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
      ? value
      : fallback;
  }
}

export class Config {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  static deepMerge(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
    if (!Config.isRecord(override)) {
      return base;
    }

    const out: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const existing = out[key];

      if (Config.isRecord(existing) && Config.isRecord(value)) {
        out[key] = Config.deepMerge(existing, value);
      } else if (value !== undefined) {
        out[key] = value;
      }
    }

    return out;
  }

  static readJson(path: string | URL): unknown {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }

  static overlayFrom(source: unknown): unknown {
    if (Config.isRecord(source)) {
      return source["statusline"];
    }

    return undefined;
  }

  static sanitizeOrder(value: unknown): SegmentId[] {
    const seen = new Set<SegmentId>();
    const order: SegmentId[] = [];
    const source = Array.isArray(value) ? value : [];

    for (const entry of source) {
      if (isSegmentId(entry) && !seen.has(entry)) {
        seen.add(entry);
        order.push(entry);
      }
    }

    for (const id of SEGMENT_IDS) {
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }

    return order;
  }

  static sanitizeSegments(value: unknown): Record<SegmentId, SegmentToggle> {
    const record = Config.isRecord(value) ? value : {};
    const out = {} as Record<SegmentId, SegmentToggle>;

    for (const id of SEGMENT_IDS) {
      const entry = record[id];
      const enabled = Config.isRecord(entry) ? entry.enabled : undefined;

      out[id] = {
        enabled: typeof enabled === "boolean" ? enabled : FALLBACK.segments[id].enabled
      };
    }

    return out;
  }

  static sanitizeConfig(raw: Record<string, unknown>): StatuslineConfig {
    return {
      order: Config.sanitizeOrder(raw.order),
      separator:
        typeof raw.separator === "string" && raw.separator !== ""
          ? raw.separator
          : FALLBACK.separator,
      segments: Config.sanitizeSegments(raw.segments),
      gitIntervalMs: Guard.positive(raw.gitIntervalMs, FALLBACK.gitIntervalMs),
      gitTimeoutMs: Guard.positive(raw.gitTimeoutMs, FALLBACK.gitTimeoutMs),
      refreshMs: Guard.positive(raw.refreshMs, FALLBACK.refreshMs),
      warnPercent: Guard.percent(raw.warnPercent, FALLBACK.warnPercent),
      errorPercent: Guard.percent(raw.errorPercent, FALLBACK.errorPercent)
    };
  }

  static fromRaw(shipped: unknown, global: unknown, project: unknown): StatuslineConfig {
    let merged: Record<string, unknown> = { ...FALLBACK };

    merged = Config.deepMerge(merged, shipped);
    merged = Config.deepMerge(merged, Config.overlayFrom(global));
    merged = Config.deepMerge(merged, Config.overlayFrom(project));

    return Config.sanitizeConfig(merged);
  }
}
