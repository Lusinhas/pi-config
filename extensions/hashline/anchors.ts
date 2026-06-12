export type AnchorOp = "replace" | "insertafter" | "insertbefore" | "delete";

export interface LineEdit {
  line: number;
  op: AnchorOp;
  text?: string;
}

export interface ParsedFile {
  lines: string[];
  eols: string[];
  dominantEol: string;
}

export interface ResolvedEdit {
  edit: LineEdit;
  lineNumber: number;
}

export interface ApplyCounts {
  replace: number;
  insert: number;
  delete: number;
}

export interface ApplyOutcome {
  lines: string[];
  eols: string[];
  counts: ApplyCounts;
  netDelta: number;
  regionStart: number;
  regionEnd: number;
}

export class StaleAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleAnchorError";
  }
}

export function parseContent(content: string): ParsedFile {
  if (content === "") return { lines: [], eols: [], dominantEol: "\n" };
  const lines: string[] = [];
  const eols: string[] = [];
  let start = 0;
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      const hasCr = i > start && content.charCodeAt(i - 1) === 13;
      lines.push(content.slice(start, hasCr ? i - 1 : i));
      eols.push(hasCr ? "\r\n" : "\n");
      if (hasCr) crlf += 1;
      else lf += 1;
      start = i + 1;
    }
  }
  if (start < content.length) {
    lines.push(content.slice(start));
    eols.push("");
  }
  return { lines, eols, dominantEol: crlf > lf ? "\r\n" : "\n" };
}

export function joinContent(lines: string[], eols: string[]): string {
  let out = "";
  for (let i = 0; i < lines.length; i += 1) {
    out += lines[i] + (eols[i] ?? "\n");
  }
  return out;
}

export function renderNumberedLine(lineNumber: number, text: string, maxLineLength: number): string {
  const display =
    text.length > maxLineLength
      ? `${text.slice(0, maxLineLength)} [line truncated: ${text.length - maxLineLength} more chars]`
      : text;
  return `${lineNumber}: ${display}`;
}

export function splitText(text: string): string[] {
  const stripped = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  return stripped.split(/\r\n|\n/);
}

export class SnapshotCache {
  private readonly byPath = new Map<string, Map<number, string>>();

  merge(path: string, lines: ReadonlyMap<number, string>): void {
    const existing = this.byPath.get(path) ?? new Map<number, string>();
    for (const [lineNumber, text] of lines) existing.set(lineNumber, text);
    this.byPath.set(path, existing);
  }

  replaceAll(path: string, lines: readonly string[]): void {
    const entries = new Map<number, string>();
    for (let i = 0; i < lines.length; i += 1) entries.set(i + 1, lines[i]);
    this.byPath.set(path, entries);
  }

  lookup(path: string, lineNumber: number): string | undefined {
    return this.byPath.get(path)?.get(lineNumber);
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  clear(): void {
    this.byPath.clear();
  }
}

const OP_PRIORITY: Record<AnchorOp, number> = { insertafter: 0, replace: 1, delete: 1, insertbefore: 2 };

export function applyEdits(parsed: ParsedFile, resolved: ResolvedEdit[]): ApplyOutcome {
  if (resolved.length === 0) throw new Error("no edits to apply");
  const lines = [...parsed.lines];
  const eols = [...parsed.eols];
  const hadTrailingNewline = parsed.eols.length > 0 && parsed.eols[parsed.eols.length - 1] !== "";
  const ordered = resolved
    .map((entry, index) => ({ ...entry, index }))
    .sort(
      (a, b) =>
        b.lineNumber - a.lineNumber || OP_PRIORITY[a.edit.op] - OP_PRIORITY[b.edit.op] || b.index - a.index,
    );
  const counts: ApplyCounts = { replace: 0, insert: 0, delete: 0 };
  let netDelta = 0;
  let regionStart = Number.POSITIVE_INFINITY;
  let regionEnd = 0;
  for (const entry of ordered) {
    const idx = entry.lineNumber - 1;
    regionStart = Math.min(regionStart, entry.lineNumber);
    regionEnd = Math.max(regionEnd, entry.lineNumber);
    if (entry.edit.op === "delete") {
      lines.splice(idx, 1);
      eols.splice(idx, 1);
      counts.delete += 1;
      netDelta -= 1;
    } else if (entry.edit.op === "replace") {
      const repl = splitText(entry.edit.text ?? "");
      const tail = eols[idx];
      const replEols = repl.map(() => parsed.dominantEol);
      replEols[replEols.length - 1] = tail;
      lines.splice(idx, 1, ...repl);
      eols.splice(idx, 1, ...replEols);
      counts.replace += 1;
      netDelta += repl.length - 1;
    } else {
      const ins = splitText(entry.edit.text ?? "");
      const at = entry.edit.op === "insertafter" ? idx + 1 : idx;
      lines.splice(at, 0, ...ins);
      eols.splice(at, 0, ...ins.map(() => parsed.dominantEol));
      counts.insert += 1;
      netDelta += ins.length;
    }
  }
  for (let i = 0; i < eols.length - 1; i += 1) {
    if (eols[i] === "") eols[i] = parsed.dominantEol;
  }
  if (eols.length > 0) {
    const last = eols.length - 1;
    if (hadTrailingNewline) {
      if (eols[last] === "") eols[last] = parsed.dominantEol;
    } else {
      eols[last] = "";
    }
  }
  const total = lines.length;
  const start = total === 0 ? 0 : Math.max(1, Math.min(regionStart, total));
  let end = regionEnd + netDelta;
  if (end > total) end = total;
  if (end < start - 1) end = start - 1;
  return { lines, eols, counts, netDelta, regionStart: start, regionEnd: end };
}
