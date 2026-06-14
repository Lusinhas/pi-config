import { Text, type RenderOptions } from "./text.ts";

interface OpLineEdit {
  kind: "opline";
  op: string;
  anchor: string;
  line: number | undefined;
  text: string;
}

interface ReplaceEdit {
  kind: "replace";
  oldText: string;
  newText: string;
}

type ArrayEdit = OpLineEdit | ReplaceEdit;

export class Previews {
  bash(input: Record<string, unknown>): string[] | undefined {
    if (typeof input.command !== "string" || input.command.length === 0) {
      return undefined;
    }

    return Text.splitLines(input.command.trimEnd()).map((line, index) => (index === 0 ? `$ ${line}` : `  ${line}`));
  }

  read(input: Record<string, unknown>, opts: RenderOptions): string[] | undefined {
    const path = Text.shortPath(input.path, opts.cwd);

    if (path === "") {
      return undefined;
    }

    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    let range = "";

    if (offset !== undefined && limit !== undefined) {
      range = ` (lines ${offset}–${offset + limit - 1})`;
    } else if (offset !== undefined) {
      range = ` (from line ${offset})`;
    } else if (limit !== undefined) {
      range = ` (first ${limit} lines)`;
    }

    return [`${path}${range}`];
  }

  write(input: Record<string, unknown>, opts: RenderOptions): string[] | undefined {
    const path = Text.shortPath(input.path, opts.cwd);

    if (path === "") {
      return undefined;
    }

    const content = typeof input.content === "string" ? input.content : "";
    const body = content === "" ? [] : Text.splitLines(content.trimEnd());
    const header = `${path} (${body.length} ${body.length === 1 ? "line" : "lines"})`;

    return [header, ...body.map((line) => `+ ${line}`)];
  }

  edit(input: Record<string, unknown>, opts: RenderOptions): string[] | undefined {
    const path = Text.shortPath(input.path, opts.cwd);

    if (path === "") {
      return undefined;
    }

    if (!Array.isArray(input.edits)) {
      return this.editSingle(path, input);
    }

    return this.editArray(path, input.edits);
  }

  private editSingle(path: string, input: Record<string, unknown>): string[] | undefined {
    if (typeof input.oldText !== "string") {
      return undefined;
    }

    const lines = [path];

    for (const line of Text.splitLines(input.oldText.trimEnd())) {
      lines.push(`- ${line}`);
    }

    if (typeof input.newText === "string" && input.newText !== "") {
      for (const line of Text.splitLines(input.newText.trimEnd())) {
        lines.push(`+ ${line}`);
      }
    }

    return lines;
  }

  private editArray(path: string, edits: unknown[]): string[] {
    const lines = [path];

    edits.forEach((raw, index) => {
      const edit = this.classifyEdit(raw);

      if (edit === undefined) {
        return;
      }

      if (index > 0) {
        lines.push("···");
      }

      if (edit.kind === "opline") {
        this.appendOpLine(lines, edit);

        return;
      }

      this.appendReplace(lines, edit);
    });

    return lines;
  }

  private classifyEdit(raw: unknown): ArrayEdit | undefined {
    if (!Text.isRecord(raw)) {
      return undefined;
    }

    if (typeof raw.op === "string" && (typeof raw.anchor === "string" || typeof raw.line === "number")) {
      return {
        kind: "opline",
        op: raw.op,
        anchor: typeof raw.anchor === "string" ? raw.anchor : "",
        line: typeof raw.line === "number" ? raw.line : undefined,
        text: typeof raw.text === "string" ? raw.text : "",
      };
    }

    return {
      kind: "replace",
      oldText: typeof raw.oldText === "string" ? raw.oldText : "",
      newText: typeof raw.newText === "string" ? raw.newText : "",
    };
  }

  private appendOpLine(lines: string[], edit: OpLineEdit): void {
    const target = edit.anchor.trim() !== "" ? `@${edit.anchor.trim().replace(/^@/, "")}` : `line ${String(edit.line)}`;
    lines.push(`${target} ${edit.op}`);

    const prefix = edit.op === "delete" ? "-" : "+";

    if (edit.text !== "") {
      for (const line of Text.splitLines(edit.text.trimEnd())) {
        lines.push(`${prefix} ${line}`);
      }
    }
  }

  private appendReplace(lines: string[], edit: ReplaceEdit): void {
    if (edit.oldText !== "") {
      for (const line of Text.splitLines(edit.oldText.trimEnd())) {
        lines.push(`- ${line}`);
      }
    }

    if (edit.newText !== "") {
      for (const line of Text.splitLines(edit.newText.trimEnd())) {
        lines.push(`+ ${line}`);
      }
    }
  }

  search(input: Record<string, unknown>, opts: RenderOptions): string[] | undefined {
    if (typeof input.pattern !== "string" || input.pattern.length === 0) {
      return undefined;
    }

    const where = Text.shortPath(input.path, opts.cwd) || ".";
    const extras: string[] = [];

    if (typeof input.glob === "string" && input.glob.length > 0) {
      extras.push(`glob ${input.glob}`);
    }

    if (input.ignoreCase === true) {
      extras.push("ignore case");
    }

    if (input.literal === true) {
      extras.push("literal");
    }

    const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";

    return [`"${input.pattern}" in ${where}${suffix}`];
  }

  ls(input: Record<string, unknown>, opts: RenderOptions): string[] {
    return [Text.shortPath(input.path, opts.cwd) || "."];
  }

  fallback(input: Record<string, unknown>): string[] {
    const lines: string[] = [];

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) {
        continue;
      }

      if (typeof value === "string") {
        const valueLines = Text.splitLines(value.trimEnd());

        if (valueLines.length <= 1) {
          lines.push(`${key}: ${valueLines[0] ?? ""}`);
        } else {
          lines.push(`${key}:`);

          for (const line of valueLines) {
            lines.push(`  ${line}`);
          }
        }
      } else {
        lines.push(`${key}: ${Text.safeStringify(value)}`);
      }
    }

    return lines;
  }
}
