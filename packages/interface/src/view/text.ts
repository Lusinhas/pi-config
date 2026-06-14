import { homedir } from "node:os";

export interface RenderOptions {
  maxLines: number;
  maxLineChars: number;
  cwd: string;
}

export type ToolRenderer = (input: Record<string, unknown>, opts: RenderOptions) => string[] | undefined;

export class Text {
  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  static safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }

  static splitLines(text: string): string[] {
    return text.replace(/\r\n/g, "\n").split("\n");
  }

  static clip(line: string, maxChars: number): string {
    const sanitized = line.replace(/[\r\u0000-\u0008\u000B-\u001F]/g, " ");

    if (maxChars <= 0 || sanitized.length <= maxChars) {
      return sanitized;
    }

    return `${sanitized.slice(0, Math.max(1, maxChars - 1))}…`;
  }

  static capLines(lines: string[], opts: RenderOptions): string[] {
    const clipped = lines.map((line) => Text.clip(line, opts.maxLineChars));

    if (opts.maxLines <= 0 || clipped.length <= opts.maxLines) {
      return clipped;
    }

    const kept = clipped.slice(0, Math.max(1, opts.maxLines - 1));
    kept.push(`… (+${clipped.length - kept.length} more lines)`);

    return kept;
  }

  static shortPath(value: unknown, cwd: string): string {
    if (typeof value !== "string" || value.length === 0) {
      return "";
    }

    if (cwd.length > 0) {
      if (value === cwd) {
        return ".";
      }

      if (value.startsWith(`${cwd}/`)) {
        return value.slice(cwd.length + 1);
      }
    }

    const home = homedir();

    if (home.length > 0 && value.startsWith(`${home}/`)) {
      return `~${value.slice(home.length)}`;
    }

    return value;
  }
}
