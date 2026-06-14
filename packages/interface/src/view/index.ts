import { Previews } from "./previews.ts";
import { Text, type RenderOptions, type ToolRenderer } from "./text.ts";

export type { RenderOptions, ToolRenderer } from "./text.ts";
export { Text } from "./text.ts";
export { Previews } from "./previews.ts";
export { Dialog, type Chrome, type Layout, type LayoutInput, type PreviewSelectParams } from "./dialog.ts";
export { Config, DEFAULTS, type ToolViewConfig } from "./config.ts";

export class Renderer {
  private readonly previews: Previews;
  private readonly builtins: ReadonlyMap<string, ToolRenderer>;

  constructor() {
    this.previews = new Previews();
    const search = this.previews.search.bind(this.previews);
    this.builtins = new Map<string, ToolRenderer>([
      ["bash", this.previews.bash.bind(this.previews)],
      ["read", this.previews.read.bind(this.previews)],
      ["write", this.previews.write.bind(this.previews)],
      ["edit", this.previews.edit.bind(this.previews)],
      ["grep", search],
      ["find", search],
      ["ls", this.previews.ls.bind(this.previews)],
    ]);
  }

  renderToolCall(toolName: string, input: unknown, opts: RenderOptions, custom?: ReadonlyMap<string, ToolRenderer>): string[] {
    const record = Text.isRecord(input) ? input : {};
    const renderer = custom?.get(toolName) ?? this.builtins.get(toolName);
    let lines: string[] | undefined;

    if (renderer) {
      try {
        lines = renderer(record, opts);
      } catch {
        lines = undefined;
      }
    }

    if (lines === undefined) {
      if (!Text.isRecord(input)) {
        lines = input === undefined || input === null ? [] : [Text.safeStringify(input)];
      } else {
        lines = this.previews.fallback(record);
      }
    }

    return Text.capLines(
      lines.filter((line): line is string => typeof line === "string"),
      opts,
    );
  }

  renderToolCallCompact(toolName: string, input: unknown, maxChars: number, cwd: string, custom?: ReadonlyMap<string, ToolRenderer>): string {
    const lines = this.renderToolCall(toolName, input, { maxLines: 2, maxLineChars: maxChars, cwd }, custom);
    const first = (lines[0] ?? "").replace(/\s+/g, " ").trim();

    if (first === "") {
      return "";
    }

    return Text.clip(lines.length > 1 ? `${first} …` : first, maxChars);
  }
}
