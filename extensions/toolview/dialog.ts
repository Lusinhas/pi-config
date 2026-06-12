import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface PreviewSelectParams {
  title: string;
  preview: string[];
  footer: string[];
  options: string[];
  viewport: number;
}

const HEIGHT_RATIO = 0.6;
const BOTTOM_MARGIN = 5;
const MIN_HEIGHT = 16;

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

function plural(count: number): string {
  return count === 1 ? "line" : "lines";
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

export async function selectWithPreview(ctx: ExtensionContext, params: PreviewSelectParams): Promise<string | undefined> {
  if (!ctx.hasUI) {
    return undefined;
  }
  const options = params.options.filter((option) => option.length > 0);
  if (options.length === 0) {
    return undefined;
  }
  const viewport = Math.max(3, params.viewport);
  if (ctx.mode !== "tui") {
    const visible = params.preview.slice(0, viewport);
    if (params.preview.length > visible.length) {
      visible.push(`… (+${params.preview.length - visible.length} more ${plural(params.preview.length - visible.length)})`);
    }
    const body = visible.length > 0 ? visible : ["(no arguments)"];
    const title = [params.title, ...body.map((line) => `  ${line}`), ...params.footer].join("\n");
    return await ctx.ui.select(title, options);
  }
  return await ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) => {
      const themed = theme as unknown as ThemeLike;
      let scroll = 0;
      let selected = 0;
      let pageRows = viewport;
      let maxScroll = 0;
      const terminalRows = (): number => {
        const rows = tui.terminal.rows;
        return typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
      };
      const refresh = (): void => {
        try {
          tui.requestRender();
        } catch {}
      };
      return {
        render(width: number): string[] {
          const usable = Math.max(24, width);
          let title = wrapLines([params.title], usable);
          const footer = wrapLines(params.footer, usable);
          const body = wrapLines(params.preview, usable - 2);
          const rows = terminalRows();
          const cap = Math.max(Math.floor(rows * HEIGHT_RATIO), MIN_HEIGHT);
          const margin = Math.min(BOTTOM_MARGIN, Math.max(0, rows - cap));
          const budget = Math.max(1, Math.min(cap, rows - margin));
          const indicatorRows = body.length > 1 ? 2 : 0;
          let showBlanks = true;
          let showHints = true;
          let showFooter = true;
          const chrome = (): number =>
            title.length + (showFooter ? footer.length : 0) + options.length + (showBlanks ? 4 : 0) + (showHints ? 1 : 0);
          if (chrome() + indicatorRows + 1 > budget) showBlanks = false;
          if (chrome() + indicatorRows + 1 > budget) showHints = false;
          if (chrome() + indicatorRows + 1 > budget) showFooter = false;
          if (chrome() + indicatorRows + 1 > budget && title.length > 1) title = [truncateToWidth(params.title, usable)];
          pageRows = Math.max(1, Math.min(viewport, budget - chrome() - indicatorRows));
          maxScroll = Math.max(0, body.length - pageRows);
          if (scroll > maxScroll) {
            scroll = maxScroll;
          }
          const lines: string[] = [];
          if (showBlanks) {
            lines.push("");
          }
          for (const row of title) {
            lines.push(paint(themed, "accent", row));
          }
          if (body.length === 0) {
            lines.push(paint(themed, "dim", "  (no arguments)"));
          } else {
            if (scroll > 0) {
              lines.push(paint(themed, "dim", `  ↑ ${scroll} more ${plural(scroll)}`));
            }
            for (const row of body.slice(scroll, scroll + pageRows)) {
              lines.push(truncateToWidth(`  ${row}`, usable));
            }
            const below = body.length - scroll - pageRows;
            if (below > 0) {
              lines.push(paint(themed, "dim", `  ↓ ${below} more ${plural(below)}`));
            }
          }
          if (showFooter) {
            for (const row of footer) {
              lines.push(paint(themed, "dim", row));
            }
          }
          if (showBlanks) {
            lines.push("");
          }
          options.forEach((option, position) => {
            const pointer = position === selected ? paint(themed, "accent", "› ") : "  ";
            const label = position === selected ? paint(themed, "accent", option) : option;
            lines.push(truncateToWidth(`${pointer}${position + 1}. ${label}`, usable));
          });
          if (showHints) {
            const hints = ["↑/↓ choose", "enter confirm", "esc dismiss"];
            if (maxScroll > 0) {
              hints.splice(1, 0, "PgUp/PgDn scroll");
            }
            if (showBlanks) {
              lines.push("");
            }
            lines.push(paint(themed, "dim", truncateToWidth(hints.join(" · "), usable)));
          }
          if (showBlanks) {
            lines.push("");
          }
          return lines;
        },
        handleInput(data: string): void {
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
        invalidate(): void {},
      };
    },
  );
}
