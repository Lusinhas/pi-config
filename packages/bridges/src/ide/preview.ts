import {
  applyEdits,
  joinContent,
  lineAnchor,
  parseContent,
  type AnchorOp,
  type LineEdit,
  type ParsedFile,
  type ResolvedEdit,
} from "../../../editing/src/lines/index.ts";

export const ANCHOR_OPS: ReadonlySet<string> = new Set<AnchorOp>(["replace", "insertafter", "insertbefore", "delete"]);

export function normalizeAnchor(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^@/, "") : "";
}

export function findAll(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let cursor = 0;

  while (cursor <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) break;

    positions.push(at);
    cursor = at + needle.length;
  }

  return positions;
}

export function isLineEdit(value: unknown): value is LineEdit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  const hasLine = typeof record.line === "number" && Number.isFinite(record.line);
  const hasAnchor = normalizeAnchor(record.anchor) !== "";

  return typeof record.op === "string" && ANCHOR_OPS.has(record.op) && (hasLine || hasAnchor);
}

function resolveEditLine(parsed: ParsedFile, edit: LineEdit): number | null {
  const anchor = normalizeAnchor(edit.anchor);

  if (anchor !== "") {
    const matches: number[] = [];

    for (let index = 0; index < parsed.lines.length; index += 1) {
      const lineNumber = index + 1;
      if (lineAnchor(lineNumber, parsed.lines[index]) === anchor) {
        matches.push(lineNumber);
      }
    }

    if (matches.length === 1) return matches[0];

    const line = typeof edit.line === "number" && Number.isFinite(edit.line) ? Math.floor(edit.line) : 0;
    return matches.includes(line) ? line : null;
  }

  const line = typeof edit.line === "number" && Number.isFinite(edit.line) ? Math.floor(edit.line) : 0;
  return line >= 1 && line <= parsed.lines.length ? line : null;
}

export function predictLines(before: string, edits: LineEdit[]): string | null {
  const parsed = parseContent(before);
  if (parsed.lines.length === 0) return null;

  const resolved: ResolvedEdit[] = [];
  const mutated = new Set<number>();

  for (const edit of edits) {
    const line = resolveEditLine(parsed, edit);
    if (line === null) return null;
    if (edit.op !== "delete" && typeof edit.text !== "string") return null;

    if (edit.op === "replace" || edit.op === "delete") {
      if (mutated.has(line)) return null;
      mutated.add(line);
    }

    resolved.push({ edit: { anchor: normalizeAnchor(edit.anchor) || undefined, line: edit.line, op: edit.op, text: edit.text }, lineNumber: line });
  }

  const outcome = applyEdits(parsed, resolved);
  return joinContent(outcome.lines, outcome.eols);
}

export function predictCompat(before: string, oldText: string, newTextRaw: unknown): string | null {
  if (oldText === "") return null;
  if (typeof newTextRaw !== "string") return null;
  if (oldText === newTextRaw) return null;

  const parsed = parseContent(before);
  let workingContent = before;
  let workingOld = oldText;
  let workingNew = newTextRaw;
  let restoreCrlf = false;
  let positions = findAll(workingContent, workingOld);

  if (positions.length === 0 && (before.includes("\r\n") || oldText.includes("\r\n"))) {
    workingContent = before.split("\r\n").join("\n");
    workingOld = oldText.split("\r\n").join("\n");
    workingNew = newTextRaw.split("\r\n").join("\n");
    restoreCrlf = parsed.dominantEol === "\r\n";
    positions = findAll(workingContent, workingOld);
  }

  if (positions.length !== 1) return null;

  const at = positions[0];
  let next = workingContent.slice(0, at) + workingNew + workingContent.slice(at + workingOld.length);
  if (restoreCrlf) next = next.split("\n").join("\r\n");

  return next;
}

export function predictAfter(
  abs: string,
  toolName: string,
  input: Record<string, unknown>,
  before: string | null,
): string | null {
  try {
    if (toolName === "write") {
      return typeof input.content === "string" ? input.content : null;
    }

    if (toolName !== "edit" || before === null) return null;

    const hasEdits = Array.isArray(input.edits) && input.edits.length > 0;
    const hasOldText = typeof input.oldText === "string";
    if (hasEdits === hasOldText) return null;

    if (hasEdits) {
      const edits = input.edits as unknown[];
      if (!edits.every(isLineEdit)) return null;
      return predictLines(before, edits);
    }

    return predictCompat(before, input.oldText as string, input.newText);
  } catch {
    return null;
  }
}
