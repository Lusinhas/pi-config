import type { ArtifactRecord } from "./index.ts";

export interface ArtifactsConfig {
  spillBytes: number;
  headLines: number;
  tailLines: number;
  skipTools: string[];
  maxAgeDays: number;
  retrieveLines: number;
}

export const DEFAULTS: ArtifactsConfig = {
  spillBytes: 30720,
  headLines: 40,
  tailLines: 20,
  skipTools: ["artifact"],
  maxAgeDays: 7,
  retrieveLines: 200,
};

export interface Clip {
  text: string;
  clipped: boolean;
}

export class Config {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = out[key];
      out[key] = Config.isRecord(current) && Config.isRecord(value) ? Config.deepMerge(current, value) : value;
    }

    return out;
  }

  private static intAtLeast(value: unknown, min: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }

    const normalized = Math.floor(value);

    return normalized >= min ? normalized : fallback;
  }

  private static positiveNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private static skipTools(value: unknown): string[] {
    const tools = new Set<string>(["artifact"]);

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim() !== "") {
          tools.add(entry.trim());
        }
      }
    }

    return [...tools];
  }

  static fromLayers(layers: Array<Record<string, unknown> | null | undefined>): ArtifactsConfig {
    let merged: Record<string, unknown> = { ...DEFAULTS };

    for (const layer of layers) {
      if (Config.isRecord(layer)) {
        merged = Config.deepMerge(merged, layer);
      }
    }

    return Config.fromMerged(merged);
  }

  static fromMerged(merged: Record<string, unknown>): ArtifactsConfig {
    return {
      spillBytes: Config.intAtLeast(merged.spillBytes, 1024, DEFAULTS.spillBytes),
      headLines: Config.intAtLeast(merged.headLines, 0, DEFAULTS.headLines),
      tailLines: Config.intAtLeast(merged.tailLines, 0, DEFAULTS.tailLines),
      skipTools: Config.skipTools(merged.skipTools),
      maxAgeDays: Config.positiveNumber(merged.maxAgeDays, DEFAULTS.maxAgeDays),
      retrieveLines: Config.intAtLeast(merged.retrieveLines, 1, DEFAULTS.retrieveLines),
    };
  }
}

export class Text {
  static splitLines(text: string): string[] {
    const lines = text.split("\n");

    if (lines.length > 1 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines;
  }

  static formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "0 B";
    }

    if (bytes < 1024) {
      return `${Math.round(bytes)} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = "B";

    for (const next of units) {
      if (value < 1024) {
        break;
      }

      value /= 1024;
      unit = next;
    }

    return `${value >= 100 ? String(Math.round(value)) : value.toFixed(1)} ${unit}`;
  }

  static utf8Head(text: string, maxBytes: number): Clip {
    const buf = Buffer.from(text, "utf8");
    const cap = Math.max(0, Math.floor(maxBytes));

    if (buf.length <= cap) {
      return { text, clipped: false };
    }

    let end = cap;

    while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }

    return { text: buf.subarray(0, end).toString("utf8"), clipped: true };
  }

  static utf8Tail(text: string, maxBytes: number): Clip {
    const buf = Buffer.from(text, "utf8");
    const cap = Math.max(0, Math.floor(maxBytes));

    if (buf.length <= cap) {
      return { text, clipped: false };
    }

    let start = buf.length - cap;

    while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) {
      start += 1;
    }

    return { text: buf.subarray(start).toString("utf8"), clipped: true };
  }

  static formatAge(ts: number): string {
    if (!Number.isFinite(ts) || ts <= 0) {
      return "unknown";
    }

    const delta = Math.max(0, Date.now() - ts);
    const minutes = Math.floor(delta / 60000);

    if (minutes < 1) {
      return "just now";
    }

    if (minutes < 60) {
      return `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
      return `${hours}h`;
    }

    return `${Math.floor(hours / 24)}d`;
  }

  static buildReplacement(text: string, record: ArtifactRecord, config: ArtifactsConfig): string {
    const lines = Text.splitLines(text);
    const total = lines.length;
    const windowCap = Math.max(1024, Math.floor(config.spillBytes / 4));
    const overlap = total <= config.headLines + config.tailLines;
    const headCount = overlap ? total : config.headLines;
    const tailCount = overlap ? 0 : config.tailLines;
    const omitted = total - headCount - tailCount;
    const parts: string[] = [];

    if (headCount > 0) {
      const head = Text.utf8Head(lines.slice(0, headCount).join("\n"), windowCap);
      parts.push(head.clipped ? `${head.text}\n[head window clipped at ${Text.formatBytes(windowCap)}]` : head.text);
    }

    const shape =
      omitted > 0
        ? `showing first ${headCount} and last ${tailCount} lines; lines ${headCount + 1}-${total - tailCount} (${omitted} line${omitted === 1 ? "" : "s"}) omitted`
        : "all lines shown above but long lines were clipped; the full text is stored";

    const banner = [
      `[output spilled to artifact ${record.id}: ${Text.formatBytes(record.bytes)}, ${total} line${total === 1 ? "" : "s"} total]`,
      `[${shape}]`,
      `[retrieve with the artifact tool: {"id":"${record.id}"} reads from the start; add offset (1-based line) and limit to page through it; {"id":"list"} lists all session artifacts]`,
    ].join("\n");

    parts.push(banner);

    if (tailCount > 0) {
      const tail = Text.utf8Tail(lines.slice(total - tailCount).join("\n"), windowCap);
      parts.push(tail.clipped ? `[tail window clipped at ${Text.formatBytes(windowCap)}]\n${tail.text}` : tail.text);
    }

    return parts.join("\n\n");
  }
}
