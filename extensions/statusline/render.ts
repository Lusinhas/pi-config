import type { SegmentPart } from "./segments";

export interface ThemeLike {
  fg(token: string, text: string): string;
}

export interface TuiLike {
  requestRender(): void;
}

export interface FooterComponent {
  render(width: number): string[];
  dispose(): void;
}

export type FooterFactory = (tui: TuiLike, theme: ThemeLike) => FooterComponent;

export interface FooterHost {
  setFooter(factory: FooterFactory | undefined): void;
}

type Paint = (token: string, text: string) => string;

function codePoints(text: string): number {
  return [...text].length;
}

function clip(text: string, max: number): string {
  if (max <= 0) return "";
  const points = [...text];
  if (points.length <= max) return text;
  if (max === 1) return "…";
  return `${points.slice(0, max - 1).join("")}…`;
}

export function composeLine(
  parts: SegmentPart[],
  separator: string,
  width: number,
  paint: Paint
): string {
  if (parts.length === 0) return "";
  const max = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
  const sepWidth = codePoints(separator);
  const kept = [...parts];
  const plainWidth = (): number =>
    kept.reduce((sum, part) => sum + codePoints(part.text), 0) + (kept.length - 1) * sepWidth;
  while (kept.length > 1 && plainWidth() > max) kept.pop();
  if (kept.length === 1 && codePoints(kept[0].text) > max) {
    kept[0] = { ...kept[0], text: clip(kept[0].text, max) };
  }
  const paintedSeparator = paint("dim", separator);
  return kept.map(part => (part.token ? paint(part.token, part.text) : part.text)).join(paintedSeparator);
}

export class FooterController {
  #separator: string;
  #snapshot: () => SegmentPart[];
  #tui: TuiLike | null = null;
  #installed = false;
  #lastLine: string | null = null;
  #lastWidth = -1;
  #lastRows: string[] = [];

  constructor(separator: string, snapshot: () => SegmentPart[]) {
    this.#separator = separator;
    this.#snapshot = snapshot;
  }

  readonly factory: FooterFactory = (tui: TuiLike, theme: ThemeLike): FooterComponent => {
    this.#tui = tui;
    const paint: Paint = (token, text) => {
      try {
        const painted = theme.fg(token, text);
        return typeof painted === "string" && painted !== "" ? painted : text;
      } catch {
        return text;
      }
    };
    return {
      render: (width: number): string[] => {
        let line: string;
        try {
          line = composeLine(this.#snapshot(), this.#separator, width, paint);
        } catch {
          line = "";
        }
        if (line === this.#lastLine && width === this.#lastWidth) return this.#lastRows;
        this.#lastLine = line;
        this.#lastWidth = width;
        this.#lastRows = line === "" ? [] : [line];
        return this.#lastRows;
      },
      dispose: (): void => {
        if (this.#tui === tui) this.#tui = null;
      }
    };
  };

  get installed(): boolean {
    return this.#installed;
  }

  install(host: FooterHost): void {
    if (this.#installed) {
      this.refresh();
      return;
    }
    try {
      host.setFooter(this.factory);
      this.#installed = true;
    } catch {
      this.#installed = false;
    }
  }

  uninstall(host: FooterHost): void {
    if (!this.#installed) return;
    try {
      host.setFooter(undefined);
    } catch {}
    this.#installed = false;
    this.#tui = null;
  }

  refresh(): void {
    const tui = this.#tui;
    if (!tui) return;
    try {
      tui.requestRender();
    } catch {}
  }
}
