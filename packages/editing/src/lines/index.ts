import { contextWeight, lineAnchor } from "./hash.ts";
import { joinContent, parseContent, renderNumberedLine, splitText } from "./parse.ts";
import type { ParsedFile } from "./parse.ts";

export { joinContent, parseContent, renderNumberedLine, splitText };
export { lineAnchor };
export type { ParsedFile };

export type AnchorOp = "replace" | "insertafter" | "insertbefore" | "delete";

export interface LineEdit {
  anchor?: string;
  line?: number;
  op: AnchorOp;
  text?: string;
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

export interface CachedLine {
  lineNumber: number;
  text: string;
  anchor: string;
}

export interface LineResolution {
  lineNumber: number | null;
  shifted: boolean;
  ambiguous: boolean;
  candidates: number[];
}

interface CandidateScore {
  lineNumber: number;
  score: number;
}

export const OP_PRIORITY: Record<AnchorOp, number> = {
  insertafter: 0,
  replace: 1,
  delete: 1,
  insertbefore: 2,
};

export class StaleAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleAnchorError";
  }
}

export class SnapshotCache {
  private readonly byPath = new Map<string, Map<number, string>>();
  private readonly byAnchor = new Map<string, Map<string, CachedLine[]>>();

  private rebuildAnchors(path: string): void {
    const entries = this.byPath.get(path);

    if (!entries) {
      this.byAnchor.delete(path);

      return;
    }

    const anchors = new Map<string, CachedLine[]>();

    for (const [lineNumber, text] of entries) {
      const anchor = lineAnchor(lineNumber, text);
      const bucket = anchors.get(anchor) ?? [];
      bucket.push({ lineNumber, text, anchor });
      anchors.set(anchor, bucket);
    }

    this.byAnchor.set(path, anchors);
  }

  merge(path: string, lines: ReadonlyMap<number, string>): void {
    const existing = this.byPath.get(path) ?? new Map<number, string>();

    for (const [lineNumber, text] of lines) {
      existing.set(lineNumber, text);
    }

    this.byPath.set(path, existing);
    this.rebuildAnchors(path);
  }

  replaceAll(path: string, lines: readonly string[]): void {
    const entries = new Map<number, string>();

    for (let i = 0; i < lines.length; i += 1) {
      entries.set(i + 1, lines[i]);
    }

    this.byPath.set(path, entries);
    this.rebuildAnchors(path);
  }

  lookup(path: string, lineNumber: number): string | undefined {
    return this.byPath.get(path)?.get(lineNumber);
  }

  lookupAnchor(path: string, anchor: string): readonly CachedLine[] {
    return this.byAnchor.get(path)?.get(anchor) ?? [];
  }

  entries(path: string): ReadonlyMap<number, string> | undefined {
    return this.byPath.get(path);
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  clear(): void {
    this.byPath.clear();
    this.byAnchor.clear();
  }
}

function indexByContent(lines: readonly string[]): Map<string, number[]> {
  const index = new Map<string, number[]>();

  for (let i = 0; i < lines.length; i += 1) {
    const bucket = index.get(lines[i]);

    if (bucket === undefined) {
      index.set(lines[i], [i]);
    } else {
      bucket.push(i);
    }
  }

  return index;
}

export function resolveSnapshotLine(
  currentLines: readonly string[],
  requestedLine: number,
  snapshot: string,
  cachedLines: ReadonlyMap<number, string>,
): LineResolution {
  const positions = indexByContent(currentLines).get(snapshot);

  if (positions === undefined || positions.length === 0) {
    return { lineNumber: null, shifted: false, ambiguous: false, candidates: [] };
  }

  if (
    requestedLine >= 1 &&
    requestedLine <= currentLines.length &&
    currentLines[requestedLine - 1] === snapshot
  ) {
    return { lineNumber: requestedLine, shifted: false, ambiguous: false, candidates: [requestedLine] };
  }

  const scored: CandidateScore[] = [];

  for (const index of positions) {
    let score = 0;

    for (const [cachedLine, cachedText] of cachedLines) {
      const expectedIndex = index + (cachedLine - requestedLine);

      if (expectedIndex < 0 || expectedIndex >= currentLines.length) {
        continue;
      }

      if (currentLines[expectedIndex] === cachedText) {
        score += contextWeight(Math.abs(cachedLine - requestedLine));
      }
    }

    scored.push({ lineNumber: index + 1, score });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score || Math.abs(a.lineNumber - requestedLine) - Math.abs(b.lineNumber - requestedLine),
  );

  const bestScore = scored[0].score;
  const best = scored.filter((candidate) => candidate.score === bestScore).map((candidate) => candidate.lineNumber);

  if (best.length !== 1) {
    return { lineNumber: null, shifted: true, ambiguous: true, candidates: best };
  }

  return { lineNumber: best[0], shifted: best[0] !== requestedLine, ambiguous: false, candidates: best };
}

export function applyEdits(parsed: ParsedFile, resolved: ResolvedEdit[]): ApplyOutcome {
  if (resolved.length === 0) {
    throw new Error("no edits to apply");
  }

  const lines = [...parsed.lines];
  const eols = [...parsed.eols];
  const hadTrailingNewline = parsed.eols.length > 0 && parsed.eols[parsed.eols.length - 1] !== "";
  const ordered = resolved
    .map((entry, index) => ({ ...entry, index }))
    .sort(
      (a, b) => b.lineNumber - a.lineNumber || OP_PRIORITY[a.edit.op] - OP_PRIORITY[b.edit.op] || b.index - a.index,
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
    if (eols[i] === "") {
      eols[i] = parsed.dominantEol;
    }
  }

  if (eols.length > 0) {
    const last = eols.length - 1;

    if (hadTrailingNewline) {
      if (eols[last] === "") {
        eols[last] = parsed.dominantEol;
      }
    } else {
      eols[last] = "";
    }
  }

  const total = lines.length;
  const start = total === 0 ? 0 : Math.max(1, Math.min(regionStart, total));
  let end = regionEnd + netDelta;

  if (end > total) {
    end = total;
  }

  if (end < start - 1) {
    end = start - 1;
  }

  return { lines, eols, counts, netDelta, regionStart: start, regionEnd: end };
}
