import type { Catalog } from "./catalog.ts";
import type { Style } from "./parse.ts";

export type NoticeLevel = "info" | "warning" | "error";

export interface Notice {
  message: string;
  level: NoticeLevel;
}

export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

export interface SelectMenu {
  options: string[];
  values: string[];
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();

  return single.length <= max ? single : `${single.slice(0, Math.max(0, max - 3))}...`;
}

export class CompletionRenderer {
  static readonly CLIP = 80;

  render(catalog: Catalog, argumentPrefix: string): CompletionItem[] | null {
    const prefix = argumentPrefix.trim().toLowerCase();
    const items: CompletionItem[] = [];

    for (const style of catalog.values()) {
      items.push({ value: style.name, label: style.name, description: clip(style.description, CompletionRenderer.CLIP) });
    }

    items.push({ value: "off", label: "off", description: "Disable the output style addendum" });

    const filtered = items.filter((item) => item.value.toLowerCase().startsWith(prefix));

    return filtered.length > 0 ? filtered : null;
  }
}

export class MenuRenderer {
  static readonly CLIP = 100;

  render(catalog: Catalog, active: string): SelectMenu {
    const options: string[] = [];
    const values: string[] = [];
    const activeKey = active.toLowerCase();

    for (const style of catalog.values()) {
      const marker = style.name.toLowerCase() === activeKey ? "* " : "  ";
      options.push(`${marker}${style.name} (${style.source}) - ${clip(style.description, MenuRenderer.CLIP)}`);
      values.push(style.name);
    }

    const offMarker = activeKey === "off" ? "* " : "  ";
    options.push(`${offMarker}off - disable output style`);
    values.push("off");

    return { options, values };
  }
}

export class NoticeFactory {
  disabled(persisted: boolean): Notice {
    return {
      message: persisted
        ? "Output style disabled."
        : "Output style disabled for this session; could not persist to ~/.pi/agent/suite.json.",
      level: persisted ? "info" : "warning",
    };
  }

  applied(style: Style, persisted: boolean): Notice {
    return {
      message: persisted
        ? `Output style: ${style.name} (${style.source})`
        : `Output style ${style.name} applied for this session; could not persist to ~/.pi/agent/suite.json.`,
      level: persisted ? "info" : "warning",
    };
  }

  unknown(requested: string, available: string): Notice {
    return {
      message: available === ""
        ? `Unknown style "${requested}" and no styles are available.`
        : `Unknown style "${requested}". Available: ${available}, off`,
      level: "error",
    };
  }
}

export class Renderer {
  private readonly menus = new MenuRenderer();
  private readonly completer = new CompletionRenderer();

  clip(text: string, max: number): string {
    return clip(text, max);
  }

  buildAddendum(style: Style, incoming: string): string {
    const addendum = `## Output style: ${style.name}\n\n${style.body}`;

    return incoming === "" ? addendum : `${incoming}\n\n${addendum}`;
  }

  completions(catalog: Catalog, argumentPrefix: string): CompletionItem[] | null {
    return this.completer.render(catalog, argumentPrefix);
  }

  selectMenu(catalog: Catalog, active: string): SelectMenu {
    return this.menus.render(catalog, active);
  }

  formatNotices(catalog: Catalog, active: string): string | null {
    const lines: string[] = [];
    const errors = catalog.problems;

    if (errors.length > 0) {
      lines.push(`Styles: skipped ${errors.length} invalid style file${errors.length === 1 ? "" : "s"}:`);

      for (const error of errors) {
        lines.push(`  ${error.path}: ${error.message}`);
      }
    }

    if (active.toLowerCase() !== "off" && !catalog.has(active)) {
      lines.push(`Styles: active style "${active}" was not found; no style addendum is being applied.`);
    }

    return lines.length > 0 ? lines.join("\n") : null;
  }
}
