import type { AskOption, DisplayTarget } from "./types.ts";

export class Text {
  static clip(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();

    if (flat.length <= max) {
      return flat;
    }

    return `${flat.slice(0, Math.max(1, max - 1))}…`;
  }

  static lineWidth(): number {
    const columns = process.stdout?.columns;

    if (typeof columns === "number" && Number.isFinite(columns) && columns > 0) {
      return Math.max(40, columns - 4);
    }

    return 160;
  }

  static optionDisplay(option: AskOption): string {
    const full =
      option.description !== undefined && option.description !== ""
        ? `${option.label} — ${option.description}`
        : option.label;

    return Text.clip(full, Text.lineWidth());
  }
}

export class Displays {
  private readonly used = new Set<string>();
  private readonly map = new Map<string, DisplayTarget>();
  readonly entries: string[] = [];

  add(base: string, target: DisplayTarget): void {
    const display = this.unique(base);

    this.entries.push(display);
    this.map.set(display, target);
  }

  target(display: string): DisplayTarget | undefined {
    return this.map.get(display);
  }

  private unique(base: string): string {
    if (!this.used.has(base)) {
      this.used.add(base);

      return base;
    }

    let counter = 2;
    let candidate = `${base} (${counter})`;

    while (this.used.has(candidate)) {
      counter += 1;
      candidate = `${base} (${counter})`;
    }

    this.used.add(candidate);

    return candidate;
  }
}
