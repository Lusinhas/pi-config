import { homedir } from "node:os";

export interface RenderOptions {
  maxLines: number;
  maxLineChars: number;
  cwd: string;
}

export type ToolRenderer = (input: Record<string, unknown>, opts: RenderOptions) => string[] | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function clip(line: string, maxChars: number): string {
  const sanitized = line.replace(/[\r\u0000-\u0008\u000B-\u001F]/g, " ");
  if (maxChars <= 0 || sanitized.length <= maxChars) {
    return sanitized;
  }
  return `${sanitized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function capLines(lines: string[], opts: RenderOptions): string[] {
  const clipped = lines.map((line) => clip(line, opts.maxLineChars));
  if (opts.maxLines <= 0 || clipped.length <= opts.maxLines) {
    return clipped;
  }
  const kept = clipped.slice(0, Math.max(1, opts.maxLines - 1));
  kept.push(`… (+${clipped.length - kept.length} more lines)`);
  return kept;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function shortPath(value: unknown, cwd: string): string {
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

function renderBash(input: Record<string, unknown>): string[] | undefined {
  if (typeof input.command !== "string" || input.command.length === 0) {
    return undefined;
  }
  return splitLines(input.command.trimEnd()).map((line, index) => (index === 0 ? `$ ${line}` : `  ${line}`));
}

function renderRead(input: Record<string, unknown>, opts: RenderOptions): string[] | undefined {
  const path = shortPath(input.path, opts.cwd);
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

function renderWrite(input: Record<string, unknown>, opts: RenderOptions): string[] | undefined {
  const path = shortPath(input.path, opts.cwd);
  if (path === "") {
    return undefined;
  }
  const content = typeof input.content === "string" ? input.content : "";
  const body = content === "" ? [] : splitLines(content.trimEnd());
  const header = `${path} (${body.length} ${body.length === 1 ? "line" : "lines"})`;
  return [header, ...body.map((line) => `+ ${line}`)];
}

function renderEdit(input: Record<string, unknown>, opts: RenderOptions): string[] | undefined {
  const path = shortPath(input.path, opts.cwd);
  if (path === "") {
    return undefined;
  }
  if (!Array.isArray(input.edits)) {
    if (typeof input.oldText !== "string") {
      return undefined;
    }
    const lines = [path];
    for (const line of splitLines(input.oldText.trimEnd())) {
      lines.push(`- ${line}`);
    }
    if (typeof input.newText === "string" && input.newText !== "") {
      for (const line of splitLines(input.newText.trimEnd())) {
        lines.push(`+ ${line}`);
      }
    }
    return lines;
  }
  const lines = [path];
  input.edits.forEach((edit, index) => {
    if (!isRecord(edit)) {
      return;
    }
    if (index > 0) {
      lines.push("···");
    }
    if (typeof edit.op === "string" && typeof edit.line === "number") {
      lines.push(`@${edit.line} ${edit.op}`);
      const text = typeof edit.text === "string" ? edit.text : "";
      const prefix = edit.op === "delete" ? "-" : "+";
      if (text !== "") {
        for (const line of splitLines(text.trimEnd())) {
          lines.push(`${prefix} ${line}`);
        }
      }
      return;
    }
    const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
    const newText = typeof edit.newText === "string" ? edit.newText : "";
    if (oldText !== "") {
      for (const line of splitLines(oldText.trimEnd())) {
        lines.push(`- ${line}`);
      }
    }
    if (newText !== "") {
      for (const line of splitLines(newText.trimEnd())) {
        lines.push(`+ ${line}`);
      }
    }
  });
  return lines;
}

function renderSearch(input: Record<string, unknown>, opts: RenderOptions): string[] | undefined {
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    return undefined;
  }
  const where = shortPath(input.path, opts.cwd) || ".";
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

function renderLs(input: Record<string, unknown>, opts: RenderOptions): string[] {
  return [shortPath(input.path, opts.cwd) || "."];
}

function renderFallback(input: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      const valueLines = splitLines(value.trimEnd());
      if (valueLines.length <= 1) {
        lines.push(`${key}: ${valueLines[0] ?? ""}`);
      } else {
        lines.push(`${key}:`);
        for (const line of valueLines) {
          lines.push(`  ${line}`);
        }
      }
    } else {
      lines.push(`${key}: ${safeStringify(value)}`);
    }
  }
  return lines;
}

const BUILTIN_RENDERERS: Record<string, ToolRenderer> = {
  bash: renderBash,
  read: renderRead,
  write: renderWrite,
  edit: renderEdit,
  grep: renderSearch,
  find: renderSearch,
  ls: renderLs,
};

export function renderToolCall(
  toolName: string,
  input: unknown,
  opts: RenderOptions,
  custom?: ReadonlyMap<string, ToolRenderer>,
): string[] {
  const record = isRecord(input) ? input : {};
  const renderer = custom?.get(toolName) ?? BUILTIN_RENDERERS[toolName];
  let lines: string[] | undefined;
  if (renderer) {
    try {
      lines = renderer(record, opts);
    } catch {
      lines = undefined;
    }
  }
  if (lines === undefined) {
    if (!isRecord(input)) {
      lines = input === undefined || input === null ? [] : [safeStringify(input)];
    } else {
      lines = renderFallback(record);
    }
  }
  return capLines(
    lines.filter((line): line is string => typeof line === "string"),
    opts,
  );
}

export function renderToolCallCompact(
  toolName: string,
  input: unknown,
  maxChars: number,
  cwd: string,
  custom?: ReadonlyMap<string, ToolRenderer>,
): string {
  const lines = renderToolCall(toolName, input, { maxLines: 2, maxLineChars: maxChars, cwd }, custom);
  const first = (lines[0] ?? "").replace(/\s+/g, " ").trim();
  if (first === "") {
    return "";
  }
  return clip(lines.length > 1 ? `${first} …` : first, maxChars);
}
