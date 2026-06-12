import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

type Styler = (text: string) => string;

interface RenderHost {
  requestRender: () => void;
}

const PAGE_LINES = 16;

class Pager implements Component {
  private readonly host: RenderHost;
  private readonly title: string;
  private readonly body: string;
  private readonly accent: Styler;
  private readonly dim: Styler;
  private readonly close: () => void;
  private offset = 0;
  private lastMax = 0;

  constructor(host: RenderHost, title: string, body: string, accent: Styler, dim: Styler, close: () => void) {
    this.host = host;
    this.title = title;
    this.body = body;
    this.accent = accent;
    this.dim = dim;
    this.close = close;
  }

  render(width: number): string[] {
    const usable = Math.max(24, width);
    const inner = usable - 2;
    const wrapped: string[] = [];
    for (const line of this.body.split("\n")) {
      if (line.trim() === "") {
        wrapped.push("");
        continue;
      }
      for (const part of wrapTextWithAnsi(line, inner)) wrapped.push(part);
    }
    this.lastMax = Math.max(0, wrapped.length - PAGE_LINES);
    if (this.offset > this.lastMax) this.offset = this.lastMax;
    if (this.offset < 0) this.offset = 0;
    const visible = wrapped.slice(this.offset, this.offset + PAGE_LINES);
    const end = this.offset + visible.length;
    const out: string[] = [];
    out.push("");
    out.push(truncateToWidth(this.accent(this.title), usable));
    out.push(truncateToWidth(this.dim(`lines ${wrapped.length === 0 ? 0 : this.offset + 1}-${end} of ${wrapped.length}`), usable));
    out.push("");
    for (const line of visible) out.push(truncateToWidth(` ${line}`, usable));
    out.push("");
    out.push(truncateToWidth(this.dim("up/down scroll · space page · home/end jump · esc close"), usable));
    out.push("");
    return out;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") {
      this.close();
      return;
    }
    if (matchesKey(data, "up")) this.offset -= 1;
    else if (matchesKey(data, "down")) this.offset += 1;
    else if (matchesKey(data, "space") || matchesKey(data, "right")) this.offset += PAGE_LINES;
    else if (matchesKey(data, "left")) this.offset -= PAGE_LINES;
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = Number.MAX_SAFE_INTEGER;
    else return;
    if (this.offset < 0) this.offset = 0;
    if (this.offset > this.lastMax) this.offset = this.lastMax;
    this.host.requestRender();
  }

  invalidate(): void {
    return;
  }
}

export function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    try {
      ctx.ui.notify(text, level);
      return;
    } catch {
      void 0;
    }
  }
  console.log(text);
}

export async function showText(ctx: ExtensionContext, title: string, body: string): Promise<void> {
  const text = body.trim() === "" ? "(empty)" : body;
  if (ctx.mode === "tui" && ctx.hasUI) {
    try {
      await ctx.ui.custom<boolean>(
        (tui, theme, _keybindings, done) =>
          new Pager(
            tui,
            title,
            text,
            (part: string) => theme.fg("accent", theme.bold(part)),
            (part: string) => theme.fg("dim", part),
            () => done(true),
          ),
      );
      return;
    } catch {
      void 0;
    }
  }
  console.log(`${title}\n\n${text}`);
}
