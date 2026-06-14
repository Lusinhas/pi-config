import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Dialog, Renderer, type PreviewSelectParams, type RenderOptions, type ToolRenderer, type ToolViewConfig } from "../view/index.ts";

const REGISTRY_KEY = Symbol.for("piconfig.toolview");

export interface ToolViewRegistry {
  render(toolName: string, input: unknown, overrides?: Partial<RenderOptions>): string[];
  compact(toolName: string, input: unknown, maxChars?: number, cwd?: string): string;
  register(toolName: string, renderer: ToolRenderer): void;
  selectWithPreview(
    ctx: ExtensionContext,
    params: Omit<PreviewSelectParams, "viewport"> & { viewport?: number },
  ): Promise<string | undefined>;
}

interface ThemeLike {
  fg?: (color: never, text: string) => string;
}

function paint(theme: ThemeLike | undefined, color: string, text: string): string {
  if (!theme || typeof theme.fg !== "function") {
    return text;
  }

  try {
    return theme.fg(color as never, text);
  } catch {
    return text;
  }
}

function wrapLines(lines: string[], width: number): string[] {
  const rows: string[] = [];

  for (const line of lines) {
    if (line.trim() === "") {
      rows.push("");

      continue;
    }

    for (const part of wrapTextWithAnsi(line, Math.max(8, width))) {
      rows.push(part);
    }
  }

  return rows;
}

const TOOLVIEW_MIN_WIDTH = 40;
const TOOLVIEW_WIDTH_MARGIN = 2;

function terminalWidth(fallback: number): number {
  const cols = process.stdout?.columns;

  if (typeof cols === "number" && Number.isFinite(cols) && cols > 0) {
    return Math.max(TOOLVIEW_MIN_WIDTH, cols - TOOLVIEW_WIDTH_MARGIN);
  }

  return fallback;
}

export class PreviewDialog {
  readonly #config: ToolViewConfig;

  constructor(config: ToolViewConfig) {
    this.#config = config;
  }

  async select(
    ctx: ExtensionContext,
    params: Omit<PreviewSelectParams, "viewport"> & { viewport?: number },
  ): Promise<string | undefined> {
    if (!ctx.hasUI) {
      return undefined;
    }

    const options = params.options.filter((option) => option.length > 0);

    if (options.length === 0) {
      return undefined;
    }

    const viewport = Math.max(3, params.viewport ?? this.#config.viewportLines);
    const full: PreviewSelectParams = { ...params, options, viewport };

    if (ctx.mode !== "tui") {
      return await ctx.ui.select(Dialog.fallbackString(full, viewport), options, { signal: params.signal });
    }

    return await this.#runTui(ctx, full, options, viewport);
  }

  #runTui(
    ctx: ExtensionContext,
    params: PreviewSelectParams,
    options: string[],
    viewport: number,
  ): Promise<string | undefined> {
    return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
      const themed = theme as unknown as ThemeLike;
      let scroll = 0;
      let selected = 0;
      let pageRows = viewport;
      let maxScroll = 0;

      if (params.signal) {
        if (params.signal.aborted) {
          done(undefined);
        } else {
          params.signal.addEventListener("abort", () => done(undefined), { once: true });
        }
      }

      const refresh = (): void => {
        try {
          tui.requestRender();
        } catch {
          void 0;
        }
      };

      return {
        render: (width: number): string[] => {
          const usable = Dialog.usableWidth(width);
          const titleRows = wrapLines([params.title], usable);
          const footerRows = wrapLines(params.footer, usable);
          const bodyRows = wrapLines(params.preview, usable - 2);
          const terminalRows = Dialog.terminalRows(tui.terminal.rows);
          const layout = Dialog.computeLayout({
            titleRows,
            footerRows,
            bodyRows,
            optionCount: options.length,
            width: usable,
            terminalRows,
            viewport,
            scroll,
          });

          pageRows = layout.pageRows;
          maxScroll = layout.maxScroll;
          scroll = layout.scroll;

          const title = layout.chrome.truncateTitle ? [truncateToWidth(params.title, usable)] : titleRows;
          const lines: string[] = [];

          if (layout.chrome.showBlanks) {
            lines.push("");
          }

          for (const row of title) {
            lines.push(paint(themed, "accent", row));
          }

          if (bodyRows.length === 0) {
            lines.push(paint(themed, "dim", "  (no arguments)"));
          } else {
            if (scroll > 0) {
              lines.push(paint(themed, "dim", `  ↑ ${scroll} more ${Dialog.plural(scroll)}`));
            }

            for (const row of bodyRows.slice(scroll, scroll + pageRows)) {
              lines.push(truncateToWidth(`  ${row}`, usable));
            }

            const below = bodyRows.length - scroll - pageRows;

            if (below > 0) {
              lines.push(paint(themed, "dim", `  ↓ ${below} more ${Dialog.plural(below)}`));
            }
          }

          if (layout.chrome.showFooter) {
            for (const row of footerRows) {
              lines.push(paint(themed, "dim", row));
            }
          }

          if (layout.chrome.showBlanks) {
            lines.push("");
          }

          options.forEach((option, position) => {
            const pointer = position === selected ? paint(themed, "accent", "› ") : "  ";
            const label = position === selected ? paint(themed, "accent", option) : option;
            lines.push(truncateToWidth(`${pointer}${position + 1}. ${label}`, usable));
          });

          if (layout.chrome.showHints) {
            const hints = ["↑/↓ choose", "enter confirm", "esc dismiss"];

            if (maxScroll > 0) {
              hints.splice(1, 0, "PgUp/PgDn scroll");
            }

            if (layout.chrome.showBlanks) {
              lines.push("");
            }

            lines.push(paint(themed, "dim", truncateToWidth(hints.join(" · "), usable)));
          }

          if (layout.chrome.showBlanks) {
            lines.push("");
          }

          return lines;
        },
        handleInput: (data: string): void => {
          if (matchesKey(data, "escape")) {
            done(undefined);

            return;
          }

          if (matchesKey(data, "enter")) {
            done(options[selected]);

            return;
          }

          if (matchesKey(data, "up")) {
            selected = (selected + options.length - 1) % options.length;
            refresh();

            return;
          }

          if (matchesKey(data, "down")) {
            selected = (selected + 1) % options.length;
            refresh();

            return;
          }

          if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
            scroll = Math.max(0, scroll - pageRows);
            refresh();

            return;
          }

          if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
            scroll = Math.min(maxScroll, scroll + pageRows);
            refresh();

            return;
          }

          if (matchesKey(data, "home")) {
            scroll = 0;
            refresh();

            return;
          }

          if (matchesKey(data, "end")) {
            scroll = maxScroll;
            refresh();

            return;
          }

          if (/^[1-9]$/.test(data)) {
            const index = Number.parseInt(data, 10) - 1;

            if (index < options.length) {
              done(options[index]);
            }
          }
        },
        invalidate: (): void => {
          void 0;
        },
      };
    });
  }
}

export class Registry {
  readonly #config: ToolViewConfig;
  readonly #renderer: Renderer;
  readonly #dialog: PreviewDialog;
  readonly #custom: Map<string, ToolRenderer>;

  constructor(config: ToolViewConfig) {
    this.#config = config;
    this.#renderer = new Renderer();
    this.#dialog = new PreviewDialog(config);
    this.#custom = new Map<string, ToolRenderer>();
  }

  build(): ToolViewRegistry {
    return {
      render: (toolName, input, overrides) =>
        this.#renderer.renderToolCall(
          toolName,
          input,
          {
            maxLines: overrides?.maxLines ?? this.#config.maxLines,
            maxLineChars: overrides?.maxLineChars ?? terminalWidth(this.#config.maxLineChars),
            cwd: overrides?.cwd ?? process.cwd(),
          },
          this.#custom,
        ),
      compact: (toolName, input, maxChars, cwd) =>
        this.#renderer.renderToolCallCompact(
          toolName,
          input,
          maxChars ?? terminalWidth(this.#config.compactChars),
          cwd ?? process.cwd(),
          this.#custom,
        ),
      register: (toolName, toolRenderer) => {
        this.#custom.set(toolName, toolRenderer);
      },
      selectWithPreview: (ctx, params) => this.#dialog.select(ctx, params),
    };
  }
}

export class ToolviewRegistrar {
  readonly #pi: ExtensionAPI;
  readonly #config: ToolViewConfig;
  readonly #depth: number;

  constructor(pi: ExtensionAPI, config: ToolViewConfig, depth: number) {
    this.#pi = pi;
    this.#config = config;
    this.#depth = depth;
  }

  register(): void {
    if (this.#depth > 0) {
      return;
    }

    const registry = new Registry(this.#config).build();
    const host = globalThis as unknown as Record<symbol, unknown>;
    host[REGISTRY_KEY] = registry;

    this.#pi.on("session_shutdown", () => {
      if (host[REGISTRY_KEY] === registry) {
        delete host[REGISTRY_KEY];
      }
    });
  }
}
