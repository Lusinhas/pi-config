import type { SegmentPart } from "./index.ts";
import { composeLine, type Paint } from "./compose.ts";

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

        if (line === this.#lastLine && width === this.#lastWidth) {
          return this.#lastRows;
        }

        this.#lastLine = line;
        this.#lastWidth = width;
        this.#lastRows = line === "" ? [] : [line];

        return this.#lastRows;
      },
      dispose: (): void => {
        if (this.#tui === tui) {
          this.#tui = null;
        }
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
    if (!this.#installed) {
      return;
    }

    try {
      host.setFooter(undefined);
    } catch {}

    this.#installed = false;
    this.#tui = null;
  }

  refresh(): void {
    const tui = this.#tui;

    if (!tui) {
      return;
    }

    try {
      tui.requestRender();
    } catch {}
  }
}
