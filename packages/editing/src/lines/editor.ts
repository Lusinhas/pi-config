import { writeFileSync } from "node:fs";
import {
  SnapshotCache,
  StaleAnchorError,
  applyEdits,
  joinContent,
  parseContent,
  renderNumberedLine,
  resolveSnapshotLine,
} from "./index.ts";
import type { LineEdit, ResolvedEdit } from "./index.ts";
import type { HashlineConfig } from "./config.ts";
import { findAll, formatSize, loadFile, resolvePath } from "./disk.ts";
import { ModeState, isHashMode } from "./mode.ts";
import type { HashMode } from "./mode.ts";

export interface ReadParams {
  path: string;
  offset?: number;
  limit?: number;
}

export interface EditParams {
  path: string;
  edits?: LineEdit[];
  oldText?: string;
  newText?: string;
  content?: string;
}

export interface ToolText {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolText[];
  details: Record<string, unknown>;
}

export interface EditOutcome {
  summary: string;
  details: Record<string, unknown>;
}

export interface EditStats {
  applied: number;
  rejected: number;
  stale: number;
}

export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

export type Mutation = () => EditOutcome;

export type WithQueue = (abs: string, run: () => Promise<void>) => Promise<void>;

function clampInt(value: unknown, min: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.floor(value));
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

const COMPLETIONS: readonly CompletionItem[] = [
  { value: "toggle", label: "toggle", description: "switch between hashline and compat" },
  { value: "hashline", label: "hashline", description: "force line-based editing" },
  { value: "compat", label: "compat", description: "force built-in style oldText/newText editing" },
  { value: "auto", label: "auto", description: "follow the per-model mode mapping" },
];

export class Editor {
  private readonly cache: SnapshotCache;
  private readonly config: HashlineConfig;
  private readonly modeState: ModeState;
  private readonly stats: EditStats = { applied: 0, rejected: 0, stale: 0 };

  constructor(cache: SnapshotCache, config: HashlineConfig, modeState: ModeState) {
    this.cache = cache;
    this.config = config;
    this.modeState = modeState;
  }

  read(params: ReadParams, cwd: string): ToolResult {
    const abs = resolvePath(params.path, cwd);
    const { parsed } = loadFile(abs);
    const total = parsed.lines.length;

    if (total === 0) {
      this.cache.replaceAll(abs, []);

      return {
        content: [{ type: "text", text: "(empty file)" }],
        details: { path: abs, totalLines: 0, start: 0, end: 0, truncated: false, mode: this.modeState.current() },
      };
    }

    const offset = clampInt(params.offset, 1, 1);

    if (offset > total) {
      throw new Error(`offset ${offset} is past the end of ${abs} (${total} lines)`);
    }

    const requested = clampInt(params.limit, 1, this.config.maxLines);
    const effectiveLimit = Math.min(requested, this.config.maxLines);
    const startIdx = offset - 1;
    const endIdxExclusive = Math.min(total, startIdx + effectiveLimit);
    const rendered: string[] = [];
    const entries = new Map<number, string>();
    let bytes = 0;
    let last = startIdx;
    let byteTruncated = false;

    for (let i = startIdx; i < endIdxExclusive; i += 1) {
      const text = parsed.lines[i];
      const line = renderNumberedLine(i + 1, text, this.config.maxLineLength);
      const cost = Buffer.byteLength(line, "utf8") + 1;

      if (bytes + cost > this.config.maxBytes && rendered.length > 0) {
        byteTruncated = true;

        break;
      }

      bytes += cost;
      rendered.push(line);
      entries.set(i + 1, text);
      last = i + 1;
    }

    this.cache.merge(abs, entries);

    const notes: string[] = [];

    if (byteTruncated) {
      notes.push(
        `[truncated at ${formatSize(this.config.maxBytes)}: showing lines ${offset}-${last} of ${total}; continue with offset=${last + 1}]`,
      );
    } else if (last < total) {
      notes.push(`[showing lines ${offset}-${last} of ${total}; continue with offset=${last + 1}]`);
    }

    const body = rendered.join("\n");

    return {
      content: [{ type: "text", text: notes.length > 0 ? `${body}\n${notes.join("\n")}` : body }],
      details: {
        path: abs,
        totalLines: total,
        start: offset,
        end: last,
        truncated: byteTruncated || last < total,
        mode: this.modeState.current(),
      },
    };
  }

  async edit(params: EditParams, cwd: string, withQueue: WithQueue): Promise<ToolResult> {
    try {
      const mutation = this.selectMutation(params, cwd);
      const holder: { value: EditOutcome | null } = { value: null };

      await withQueue(mutation.abs, async () => {
        holder.value = mutation.run();
      });

      if (holder.value === null) {
        throw new Error("edit did not produce a result");
      }

      this.stats.applied += 1;

      return { content: [{ type: "text", text: holder.value.summary }], details: holder.value.details };
    } catch (error) {
      this.stats.rejected += 1;

      if (error instanceof StaleAnchorError) {
        this.stats.stale += 1;
      }

      throw error;
    }
  }

  private selectMutation(params: EditParams, cwd: string): { abs: string; run: Mutation } {
    const abs = resolvePath(params.path, cwd);
    const mode = this.modeState.current();
    const lineEdits = Array.isArray(params.edits) ? params.edits : undefined;
    const hasCompat = typeof params.oldText === "string";

    if (typeof params.content === "string") {
      if (lineEdits !== undefined || hasCompat) {
        throw new Error("Provide content (whole-file replacement) on its own, without edits or oldText/newText");
      }

      const whole = params.content;

      return { abs, run: () => this.applyFullContent(abs, whole) };
    }

    if (lineEdits !== undefined && hasCompat) {
      throw new Error("Provide either edits (line operations) or oldText/newText, not both");
    }

    if (lineEdits === undefined && !hasCompat) {
      throw new Error(
        "Provide edits: [{anchor, op, text?}] using @hash anchors from the latest read, or the compat form {oldText, newText}",
      );
    }

    if (lineEdits !== undefined && lineEdits.length === 0) {
      throw new Error("edits must contain at least one operation");
    }

    if (hasCompat && mode === "hashline" && !this.config.compat) {
      throw new Error(
        "Plain oldText/newText editing is disabled here; read the file and use hash-anchor edits: {path, edits: [{anchor, op, text?}]}",
      );
    }

    if (lineEdits !== undefined) {
      return { abs, run: () => this.applyLineBatch(abs, lineEdits) };
    }

    return { abs, run: () => this.applyCompat(abs, params.oldText as string, params.newText) };
  }

  applyLineBatch(abs: string, edits: LineEdit[]): EditOutcome {
    const { parsed } = loadFile(abs);

    if (parsed.lines.length === 0) {
      throw new Error(`${abs} is empty; use the write tool to add content`);
    }

    if (!this.cache.has(abs)) {
      throw new StaleAnchorError(
        `Edit rejected: ${abs} has not been read this session; read it first and target the @hash anchors it shows.`,
      );
    }

    const total = parsed.lines.length;
    const cachedLines = this.cache.entries(abs);

    if (cachedLines === undefined) {
      throw new StaleAnchorError(
        `Edit rejected: ${abs} has not been read this session; read it first and target the @hash anchors it shows.`,
      );
    }

    const problems: string[] = [];
    const shiftedAnchors: string[] = [];
    let staleSeen = false;
    const resolved: ResolvedEdit[] = [];
    const mutated = new Set<number>();

    edits.forEach((edit, position) => {
      const label = `edit ${position + 1}`;
      const anchor = typeof edit.anchor === "string" ? edit.anchor.trim().replace(/^@/, "") : "";
      const hasAnchor = anchor !== "";
      const legacyLine = typeof edit.line === "number" && Number.isFinite(edit.line) ? Math.floor(edit.line) : 0;

      if (!hasAnchor && legacyLine < 1) {
        problems.push(`${label}: provide anchor from read output, e.g. {anchor: "abc1234", op: "replace", text: "..."}`);

        return;
      }

      if (edit.op !== "delete" && typeof edit.text !== "string") {
        problems.push(`${label}: op "${edit.op}" requires text`);

        return;
      }

      let requestedLine = legacyLine;
      let snapshot = "";
      let target = `line ${legacyLine}`;

      if (hasAnchor) {
        const matches = this.cache.lookupAnchor(abs, anchor);

        if (matches.length === 0) {
          staleSeen = true;
          problems.push(`${label}: anchor @${anchor} was not in your latest read of this file; re-read ${abs} and use a fresh anchor.`);

          return;
        }

        if (matches.length > 1 && legacyLine > 0) {
          const exact = matches.filter((match) => match.lineNumber === legacyLine);

          if (exact.length === 1) {
            requestedLine = exact[0].lineNumber;
            snapshot = exact[0].text;
            target = `anchor @${anchor} at cached line ${legacyLine}`;
          } else {
            staleSeen = true;
            problems.push(`${label}: anchor @${anchor} matches ${matches.length} cached lines, but not cached line ${legacyLine}; re-read ${abs} to disambiguate.`);

            return;
          }
        } else if (matches.length > 1) {
          staleSeen = true;
          problems.push(`${label}: anchor @${anchor} matches ${matches.length} cached lines; include the line number from read output, or re-read ${abs} to disambiguate.`);

          return;
        }

        if (snapshot === "") {
          requestedLine = matches[0].lineNumber;
          snapshot = matches[0].text;
          target = `anchor @${anchor}`;
        }
      } else {
        const legacySnapshot = this.cache.lookup(abs, requestedLine);

        if (legacySnapshot === undefined) {
          staleSeen = true;
          problems.push(`${label}: line ${requestedLine} was not in your most recent read of this file; re-read it or use a hash anchor from read output.`);

          return;
        }

        snapshot = legacySnapshot;
      }

      const resolution = resolveSnapshotLine(parsed.lines, requestedLine, snapshot, cachedLines);

      if (resolution.lineNumber === null) {
        staleSeen = true;

        if (resolution.ambiguous) {
          const shown = resolution.candidates.slice(0, 5).join(", ");
          const extra = resolution.candidates.length > 5 ? `, +${resolution.candidates.length - 5} more` : "";
          problems.push(`${label}: ${target} moved, but its cached text now matches multiple locations (${shown}${extra}); re-read ${abs} to disambiguate.`);
        } else {
          const current =
            requestedLine <= total
              ? `file now has "${clip(parsed.lines[requestedLine - 1])}" at old line ${requestedLine}`
              : `file now has only ${total} lines`;
          problems.push(`${label}: ${target} changed since your last read (you saw "${clip(snapshot)}"; ${current}; cached line content was not found elsewhere).`);
        }

        return;
      }

      const lineNumber = resolution.lineNumber;

      if (resolution.shifted) {
        shiftedAnchors.push(`${label}: ${target} moved from line ${requestedLine} to ${lineNumber}`);
      }

      if (edit.op === "replace" || edit.op === "delete") {
        if (mutated.has(lineNumber)) {
          staleSeen = true;
          problems.push(`${label}: conflicting ${edit.op} on resolved line ${lineNumber}; only one replace or delete may target a line`);

          return;
        }

        mutated.add(lineNumber);
      }

      resolved.push({ edit: { anchor: hasAnchor ? anchor : undefined, line: requestedLine, op: edit.op, text: edit.text }, lineNumber });
    });

    if (problems.length > 0) {
      const message = `Edit rejected, nothing was applied:\n${problems.join("\n")}\nRe-read ${abs} and retry with fresh @hash anchors.`;

      if (staleSeen) {
        throw new StaleAnchorError(message);
      }

      throw new Error(message);
    }

    const outcome = applyEdits(parsed, resolved);
    writeFileSync(abs, joinContent(outcome.lines, outcome.eols), "utf8");
    this.cache.replaceAll(abs, outcome.lines);

    const region = this.renderRegion(outcome.lines, outcome.regionStart, outcome.regionEnd);
    const delta = outcome.netDelta >= 0 ? `+${outcome.netDelta}` : `${outcome.netDelta}`;
    const shiftedNote = shiftedAnchors.length > 0 ? ` Resolved shifted anchors: ${shiftedAnchors.join("; ")}.` : "";
    const header = `Edited ${abs}: ${resolved.length} edit(s) applied (${outcome.counts.replace} replace, ${outcome.counts.insert} insert, ${outcome.counts.delete} delete, ${delta} line(s)).${shiftedNote}`;
    const body = region.length > 0 ? `Updated region with fresh anchors:\n${region.join("\n")}` : "(file is now empty)";

    return {
      summary: `${header}\n${body}`,
      details: {
        path: abs,
        form: "anchors",
        applied: resolved.length,
        netDelta: outcome.netDelta,
        totalLines: outcome.lines.length,
        shiftedAnchors: shiftedAnchors.length,
      },
    };
  }

  applyFullContent(abs: string, content: string): EditOutcome {
    writeFileSync(abs, content, "utf8");

    const updated = parseContent(content);
    this.cache.replaceAll(abs, updated.lines);

    const total = updated.lines.length;
    const shown = Math.min(total, 40);
    const region = this.renderRegion(updated.lines, 1, shown);
    const more = total > shown ? `\n… ${total - shown} more line(s)` : "";
    const body = region.length > 0 ? `Updated file with fresh anchors:\n${region.join("\n")}${more}` : "(file is now empty)";

    return {
      summary: `Edited ${abs}: wrote whole file (${total} line(s)).\n${body}`,
      details: { path: abs, form: "content", applied: 1, totalLines: total },
    };
  }

  applyCompat(abs: string, oldText: string, newTextRaw: string | undefined): EditOutcome {
    if (oldText === "") {
      throw new Error("oldText must not be empty");
    }

    if (typeof newTextRaw !== "string") {
      throw new Error("newText is required with oldText; pass an empty string to delete the matched text");
    }

    if (oldText === newTextRaw) {
      throw new Error("oldText and newText are identical; nothing to change");
    }

    const { content, parsed } = loadFile(abs);
    let workingContent = content;
    let workingOld = oldText;
    let workingNew = newTextRaw;
    let restoreCrlf = false;
    let positions = findAll(workingContent, workingOld);

    if (positions.length === 0 && (content.includes("\r\n") || oldText.includes("\r\n"))) {
      workingContent = content.split("\r\n").join("\n");
      workingOld = oldText.split("\r\n").join("\n");
      workingNew = newTextRaw.split("\r\n").join("\n");
      restoreCrlf = parsed.dominantEol === "\r\n";
      positions = findAll(workingContent, workingOld);
    }

    if (positions.length === 0) {
      throw new Error(`oldText was not found in ${abs}; copy it exactly (including whitespace) from a fresh read, or use hash-anchor edits`);
    }

    if (positions.length > 1) {
      throw new Error(`oldText matches ${positions.length} places in ${abs}; add surrounding context so the match is unique`);
    }

    const at = positions[0];
    let next = workingContent.slice(0, at) + workingNew + workingContent.slice(at + workingOld.length);

    if (restoreCrlf) {
      next = next.split("\n").join("\r\n");
    }

    writeFileSync(abs, next, "utf8");

    const updated = parseContent(next);
    this.cache.replaceAll(abs, updated.lines);

    const startLine = workingContent.slice(0, at).split("\n").length;
    const addedLines = workingNew === "" ? 0 : workingNew.split("\n").length;
    const removedLines = workingOld.split("\n").length;
    const endLine = startLine + addedLines - 1;
    const region = this.renderRegion(updated.lines, startLine, endLine);
    const header = `Edited ${abs}: replaced 1 occurrence of oldText (-${removedLines} +${addedLines} line(s)).`;
    const body = region.length > 0 ? `Updated region with fresh anchors:\n${region.join("\n")}` : "(file is now empty)";

    return {
      summary: `${header}\n${body}`,
      details: {
        path: abs,
        form: "compat",
        applied: 1,
        netDelta: addedLines - removedLines,
        totalLines: updated.lines.length,
      },
    };
  }

  renderRegion(lines: string[], start: number, end: number): string[] {
    const total = lines.length;

    if (total === 0) {
      return [];
    }

    const safeStart = Math.max(1, Math.min(start, total));
    const safeEnd = Math.max(safeStart - 1, Math.min(end, total));
    const from = Math.max(1, safeStart - this.config.contextLines);
    const to = Math.min(total, safeEnd + this.config.contextLines);

    if (to < from) {
      return [];
    }

    const out: string[] = [];

    for (let i = from; i <= to; i += 1) {
      out.push(renderNumberedLine(i, lines[i - 1], this.config.maxLineLength));
    }

    return out;
  }

  statusText(): string {
    const attempts = this.stats.applied + this.stats.rejected;
    const rate = attempts === 0 ? "0.0" : ((this.stats.stale / attempts) * 100).toFixed(1);
    const model = this.modeState.model();
    const modelNote = model === "" ? "" : ` | model: ${model}`;

    return `hashline mode: ${this.modeState.current()} (${this.modeState.origin()})${modelNote} | edits applied: ${this.stats.applied} | rejected: ${this.stats.rejected} | stale: ${this.stats.stale} (${rate}% stale rate)`;
  }

  completions(argumentPrefix: string): CompletionItem[] | null {
    const prefix = argumentPrefix.trimStart().toLowerCase();
    const matches = COMPLETIONS.filter((item) => item.value.startsWith(prefix));

    return matches.length > 0 ? matches.map((item) => ({ ...item })) : null;
  }

  command(args: string): { message: string; level: "info" | "error" } {
    const trimmed = (args ?? "").trim().toLowerCase();

    if (trimmed === "") {
      return { message: this.statusText(), level: "info" };
    }

    if (trimmed === "toggle") {
      const next: HashMode = this.modeState.current() === "hashline" ? "compat" : "hashline";
      this.modeState.setOverride(next);

      return { message: `hashline mode: ${next} (manual override; /hashline auto to follow the model mapping)`, level: "info" };
    }

    if (isHashMode(trimmed)) {
      this.modeState.setOverride(trimmed);

      return { message: `hashline mode: ${trimmed} (manual override; /hashline auto to follow the model mapping)`, level: "info" };
    }

    if (trimmed === "auto") {
      this.modeState.setOverride(null);

      return { message: `hashline mode: ${this.modeState.current()} (${this.modeState.origin()} via model mapping)`, level: "info" };
    }

    return { message: `Unknown argument "${trimmed}". Usage: /hashline [toggle|hashline|compat|auto]`, level: "error" };
  }

  startSession(modelId: string): void {
    this.cache.clear();
    this.stats.applied = 0;
    this.stats.rejected = 0;
    this.stats.stale = 0;
    this.modeState.setModel(modelId);
  }

  selectModel(modelId: string): void {
    this.modeState.setModel(modelId);
  }
}
