import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  SnapshotCache,
  StaleAnchorError,
  applyEdits,
  joinContent,
  parseContent,
  renderNumberedLine,
} from "./anchors";
import type { LineEdit, ParsedFile, ResolvedEdit } from "./anchors";
import { ModeState, isHashMode } from "./formats";
import type { HashMode } from "./formats";

interface HashlineConfig {
  compat: boolean;
  defaultMode: HashMode;
  modes: Record<string, HashMode>;
  maxLines: number;
  maxBytes: number;
  maxLineLength: number;
  contextLines: number;
}

interface ReadParams {
  path: string;
  offset?: number;
  limit?: number;
}

interface EditParams {
  path: string;
  edits?: LineEdit[];
  oldText?: string;
  newText?: string;
}

interface ToolText {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolText[];
  details: Record<string, unknown>;
}

interface EditOutcome {
  summary: string;
  details: Record<string, unknown>;
}

interface LoadedFile {
  content: string;
  parsed: ParsedFile;
}

interface EditStats {
  applied: number;
  rejected: number;
  stale: number;
}

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

const DEFAULTS: HashlineConfig = {
  compat: true,
  defaultMode: "hashline",
  modes: {},
  maxLines: 2000,
  maxBytes: 51200,
  maxLineLength: 2000,
  contextLines: 2,
};

const LARGE_FILE_BYTES = 64 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && Math.floor(value) >= 1 ? Math.floor(value) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && Math.floor(value) >= 0 ? Math.floor(value) : fallback;
}

function loadConfig(): HashlineConfig {
  let merged: Record<string, unknown> = { ...DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
    if (isRecord(parsed)) merged = deepMerge(merged, parsed);
  } catch {
    merged = { ...DEFAULTS };
  }
  const globalConfig = readJson(join(homedir(), ".pi", "agent", "suite.json"));
  if (globalConfig && isRecord(globalConfig.hashline)) merged = deepMerge(merged, globalConfig.hashline);
  const projectConfig = readJson(join(process.cwd(), ".pi", "suite.json"));
  if (projectConfig && isRecord(projectConfig.hashline)) merged = deepMerge(merged, projectConfig.hashline);
  const modes: Record<string, HashMode> = {};
  if (isRecord(merged.modes)) {
    for (const [pattern, mode] of Object.entries(merged.modes)) {
      if (pattern !== "" && isHashMode(mode)) modes[pattern] = mode;
    }
  }
  return {
    compat: typeof merged.compat === "boolean" ? merged.compat : DEFAULTS.compat,
    defaultMode: isHashMode(merged.defaultMode) ? merged.defaultMode : DEFAULTS.defaultMode,
    modes,
    maxLines: positiveInt(merged.maxLines, DEFAULTS.maxLines),
    maxBytes: positiveInt(merged.maxBytes, DEFAULTS.maxBytes),
    maxLineLength: positiveInt(merged.maxLineLength, DEFAULTS.maxLineLength),
    contextLines: nonNegativeInt(merged.contextLines, DEFAULTS.contextLines),
  };
}

function resolvePath(path: unknown, cwd: string): string {
  if (typeof path !== "string" || path.trim() === "") throw new Error("path must be a non-empty string");
  const trimmed = path.trim();
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);
}

function extractModelId(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    for (const key of ["id", "model", "name"]) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate !== "") return candidate;
    }
  }
  return "";
}

function clampInt(value: unknown, min: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function findAll(haystack: string, needle: string): number[] {
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

function loadFile(abs: string): LoadedFile {
  let info;
  try {
    info = statSync(abs);
  } catch {
    throw new Error(`File not found: ${abs}`);
  }
  if (info.isDirectory()) throw new Error(`${abs} is a directory; use ls or find instead`);
  if (!info.isFile()) throw new Error(`${abs} is not a regular file`);
  if (info.size > LARGE_FILE_BYTES) {
    throw new Error(`${abs} is ${formatSize(info.size)}, larger than the ${formatSize(LARGE_FILE_BYTES)} hashline limit; use bash tools (grep, sed, head) instead`);
  }
  const buffer = readFileSync(abs);
  if (buffer.subarray(0, 8192).includes(0)) {
    throw new Error(`${abs} looks like a binary file; hashline read and edit only support text files`);
  }
  const content = buffer.toString("utf8");
  return { content, parsed: parseContent(content) };
}

const readParameters = Type.Object({
  path: Type.String({ description: "Absolute or cwd-relative path of the text file to read" }),
  offset: Type.Optional(Type.Number({ description: "1-based line number to start reading from (default 1)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return (defaults to the configured cap, normally 2000)" })),
});

const editParameters = Type.Object({
  path: Type.String({ description: "Absolute or cwd-relative path of the text file to edit" }),
  edits: Type.Optional(
    Type.Array(
      Type.Object({
        line: Type.Number({ description: "1-based line number from the latest read of this file" }),
        op: StringEnum(["replace", "insertafter", "insertbefore", "delete"], {
          description: "replace the line, insert text after or before it, or delete it",
        }),
        text: Type.Optional(
          Type.String({ description: "Replacement or inserted text; may span multiple lines; required for every op except delete" }),
        ),
      }),
      { minItems: 1, description: "Line edits for one file; verified together and applied atomically" },
    ),
  ),
  oldText: Type.Optional(Type.String({ description: "Compat form: exact existing text to replace; must match exactly one location" })),
  newText: Type.Optional(Type.String({ description: "Compat form: replacement text; pass an empty string to delete the match" })),
});

export default function hashline(pi: ExtensionAPI): void {
  const config = loadConfig();
  const cache = new SnapshotCache();
  const modeState = new ModeState(config.modes, config.defaultMode);
  const stats: EditStats = { applied: 0, rejected: 0, stale: 0 };

  const renderRegion = (lines: string[], start: number, end: number): string[] => {
    const total = lines.length;
    if (total === 0) return [];
    const safeStart = Math.max(1, Math.min(start, total));
    const safeEnd = Math.max(safeStart - 1, Math.min(end, total));
    const from = Math.max(1, safeStart - config.contextLines);
    const to = Math.min(total, safeEnd + config.contextLines);
    if (to < from) return [];
    const out: string[] = [];
    for (let i = from; i <= to; i += 1) {
      out.push(renderNumberedLine(i, lines[i - 1], config.maxLineLength));
    }
    return out;
  };

  const applyLineBatch = (abs: string, edits: LineEdit[]): EditOutcome => {
    const { parsed } = loadFile(abs);
    if (parsed.lines.length === 0) {
      throw new Error(`${abs} is empty; use the write tool to add content`);
    }
    if (!cache.has(abs)) {
      throw new StaleAnchorError(`Edit rejected: ${abs} has not been read this session; read it first and target the line numbers it shows.`);
    }
    const total = parsed.lines.length;
    const problems: string[] = [];
    let staleSeen = false;
    const resolved: ResolvedEdit[] = [];
    const mutated = new Set<number>();
    edits.forEach((edit, position) => {
      const label = `edit ${position + 1}`;
      const line = typeof edit.line === "number" && Number.isFinite(edit.line) ? Math.floor(edit.line) : 0;
      if (line < 1) {
        problems.push(`${label}: malformed line "${String(edit.line)}" (use the 1-based line numbers from read)`);
        return;
      }
      if (edit.op !== "delete" && typeof edit.text !== "string") {
        problems.push(`${label}: op "${edit.op}" requires text`);
        return;
      }
      if (line > total) {
        staleSeen = true;
        problems.push(`${label}: line ${line} is past the end of the file (${total} lines)`);
        return;
      }
      const snapshot = cache.lookup(abs, line);
      if (snapshot === undefined) {
        staleSeen = true;
        problems.push(`${label}: line ${line} was not in your most recent read of this file; re-read it (use offset/limit to cover line ${line})`);
        return;
      }
      if (snapshot !== parsed.lines[line - 1]) {
        staleSeen = true;
        problems.push(`${label}: line ${line} changed since your last read (you saw "${clip(snapshot)}", file now has "${clip(parsed.lines[line - 1])}")`);
        return;
      }
      if (edit.op === "replace" || edit.op === "delete") {
        if (mutated.has(line)) {
          staleSeen = true;
          problems.push(`${label}: conflicting ${edit.op} on line ${line}; only one replace or delete may target a line`);
          return;
        }
        mutated.add(line);
      }
      resolved.push({ edit: { line, op: edit.op, text: edit.text }, lineNumber: line });
    });
    if (problems.length > 0) {
      const message = `Edit rejected, nothing was applied:\n${problems.join("\n")}\nRe-read ${abs} and retry with fresh line numbers.`;
      if (staleSeen) throw new StaleAnchorError(message);
      throw new Error(message);
    }
    const outcome = applyEdits(parsed, resolved);
    writeFileSync(abs, joinContent(outcome.lines, outcome.eols), "utf8");
    cache.replaceAll(abs, outcome.lines);
    const region = renderRegion(outcome.lines, outcome.regionStart, outcome.regionEnd);
    const delta = outcome.netDelta >= 0 ? `+${outcome.netDelta}` : `${outcome.netDelta}`;
    const header = `Edited ${abs}: ${resolved.length} edit(s) applied (${outcome.counts.replace} replace, ${outcome.counts.insert} insert, ${outcome.counts.delete} delete, ${delta} line(s)).`;
    const body = region.length > 0 ? `Updated region with fresh line numbers:\n${region.join("\n")}` : "(file is now empty)";
    return {
      summary: `${header}\n${body}`,
      details: { path: abs, form: "lines", applied: resolved.length, netDelta: outcome.netDelta, totalLines: outcome.lines.length },
    };
  };

  const applyCompat = (abs: string, oldText: string, newTextRaw: string | undefined): EditOutcome => {
    if (oldText === "") throw new Error("oldText must not be empty");
    if (typeof newTextRaw !== "string") {
      throw new Error("newText is required with oldText; pass an empty string to delete the matched text");
    }
    if (oldText === newTextRaw) throw new Error("oldText and newText are identical; nothing to change");
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
      throw new Error(`oldText was not found in ${abs}; copy it exactly (including whitespace) from a fresh read, or use line edits`);
    }
    if (positions.length > 1) {
      throw new Error(`oldText matches ${positions.length} places in ${abs}; add surrounding context so the match is unique`);
    }
    const at = positions[0];
    let next = workingContent.slice(0, at) + workingNew + workingContent.slice(at + workingOld.length);
    if (restoreCrlf) next = next.split("\n").join("\r\n");
    writeFileSync(abs, next, "utf8");
    const updated = parseContent(next);
    cache.replaceAll(abs, updated.lines);
    const startLine = workingContent.slice(0, at).split("\n").length;
    const addedLines = workingNew === "" ? 0 : workingNew.split("\n").length;
    const removedLines = workingOld.split("\n").length;
    const endLine = startLine + addedLines - 1;
    const region = renderRegion(updated.lines, startLine, endLine);
    const header = `Edited ${abs}: replaced 1 occurrence of oldText (-${removedLines} +${addedLines} line(s)).`;
    const body = region.length > 0 ? `Updated region with fresh line numbers:\n${region.join("\n")}` : "(file is now empty)";
    return {
      summary: `${header}\n${body}`,
      details: { path: abs, form: "compat", applied: 1, netDelta: addedLines - removedLines, totalLines: updated.lines.length },
    };
  };

  pi.registerTool({
    name: "read",
    label: "Read",
    description: `Read a text file. Lines render as "<lineno>: <text>"; line numbers feed the edit tool and go stale when the file changes, so edit using your most recent read. Returns up to ${config.maxLines} lines and ${formatSize(config.maxBytes)} with truncation notes; offset is 1-based, limit caps lines.`,
    parameters: readParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const p = params as ReadParams;
      const abs = resolvePath(p.path, ctx.cwd);
      const { parsed } = loadFile(abs);
      const total = parsed.lines.length;
      if (total === 0) {
        cache.replaceAll(abs, []);
        return {
          content: [{ type: "text", text: "(empty file)" }],
          details: { path: abs, totalLines: 0, start: 0, end: 0, truncated: false, mode: modeState.current() },
        };
      }
      const offset = clampInt(p.offset, 1, 1);
      if (offset > total) throw new Error(`offset ${offset} is past the end of ${abs} (${total} lines)`);
      const requested = clampInt(p.limit, 1, config.maxLines);
      const effectiveLimit = Math.min(requested, config.maxLines);
      const startIdx = offset - 1;
      const endIdxExclusive = Math.min(total, startIdx + effectiveLimit);
      const rendered: string[] = [];
      const entries = new Map<number, string>();
      let bytes = 0;
      let last = startIdx;
      let byteTruncated = false;
      for (let i = startIdx; i < endIdxExclusive; i += 1) {
        const text = parsed.lines[i];
        const line = renderNumberedLine(i + 1, text, config.maxLineLength);
        const cost = Buffer.byteLength(line, "utf8") + 1;
        if (bytes + cost > config.maxBytes && rendered.length > 0) {
          byteTruncated = true;
          break;
        }
        bytes += cost;
        rendered.push(line);
        entries.set(i + 1, text);
        last = i + 1;
      }
      cache.merge(abs, entries);
      const notes: string[] = [];
      if (byteTruncated) {
        notes.push(`[truncated at ${formatSize(config.maxBytes)}: showing lines ${offset}-${last} of ${total}; continue with offset=${last + 1}]`);
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
          mode: modeState.current(),
        },
      };
    },
  });

  pi.registerTool({
    name: "edit",
    label: "Edit",
    description:
      'Edit a text file using line numbers from the most recent read; batch all changes to one file into a single call. Primary form: {path, edits: [{line, op, text?}]} with op replace (text may be multi-line), insertafter, insertbefore, or delete. Every target line is verified against the file on disk; if anything changed since your read the whole call is rejected — re-read and retry. Edits apply atomically and the response shows the changed region with fresh line numbers. Compat form: {path, oldText, newText} replaces one unique occurrence.',
    parameters: editParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const p = params as EditParams;
      try {
        const abs = resolvePath(p.path, ctx.cwd);
        const mode = modeState.current();
        const lineEdits = Array.isArray(p.edits) ? p.edits : undefined;
        const hasCompat = typeof p.oldText === "string";
        if (lineEdits !== undefined && hasCompat) {
          throw new Error("Provide either edits (line operations) or oldText/newText, not both");
        }
        if (lineEdits === undefined && !hasCompat) {
          throw new Error('Provide edits: [{line, op, text?}] using line numbers from the latest read, or the compat form {oldText, newText}');
        }
        if (lineEdits !== undefined && lineEdits.length === 0) {
          throw new Error("edits must contain at least one operation");
        }
        if (hasCompat && mode === "hashline" && !config.compat) {
          throw new Error("Plain oldText/newText editing is disabled here; read the file and use line edits: {path, edits: [{line, op, text?}]}");
        }
        const holder: { value: EditOutcome | null } = { value: null };
        await withFileMutationQueue(abs, async () => {
          holder.value =
            lineEdits !== undefined ? applyLineBatch(abs, lineEdits) : applyCompat(abs, p.oldText as string, p.newText);
        });
        if (holder.value === null) throw new Error("edit did not produce a result");
        stats.applied += 1;
        return { content: [{ type: "text", text: holder.value.summary }], details: holder.value.details };
      } catch (error) {
        stats.rejected += 1;
        if (error instanceof StaleAnchorError) stats.stale += 1;
        throw error;
      }
    },
  });

  const statusText = (): string => {
    const attempts = stats.applied + stats.rejected;
    const rate = attempts === 0 ? "0.0" : ((stats.stale / attempts) * 100).toFixed(1);
    const model = modeState.model();
    const modelNote = model === "" ? "" : ` | model: ${model}`;
    return `hashline mode: ${modeState.current()} (${modeState.origin()})${modelNote} | edits applied: ${stats.applied} | rejected: ${stats.rejected} | stale: ${stats.stale} (${rate}% stale rate)`;
  };

  pi.registerCommand("hashline", {
    description: "Show hashline mode and edit stats; /hashline toggle|hashline|compat|auto switches mode",
    getArgumentCompletions: (argumentPrefix: string): CompletionItem[] | null => {
      const prefix = argumentPrefix.trimStart().toLowerCase();
      const items: CompletionItem[] = [
        { value: "toggle", label: "toggle", description: "switch between hashline and compat" },
        { value: "hashline", label: "hashline", description: "force line-based editing" },
        { value: "compat", label: "compat", description: "force built-in style oldText/newText editing" },
        { value: "auto", label: "auto", description: "follow the per-model mode mapping" },
      ];
      const matches = items.filter((item) => item.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx): Promise<void> => {
      const notify = (message: string, level: "info" | "error"): void => {
        if (ctx.hasUI) ctx.ui.notify(message, level);
      };
      const trimmed = (args ?? "").trim().toLowerCase();
      if (trimmed === "") {
        notify(statusText(), "info");
        return;
      }
      if (trimmed === "toggle") {
        const next: HashMode = modeState.current() === "hashline" ? "compat" : "hashline";
        modeState.setOverride(next);
        notify(`hashline mode: ${next} (manual override; /hashline auto to follow the model mapping)`, "info");
        return;
      }
      if (isHashMode(trimmed)) {
        modeState.setOverride(trimmed);
        notify(`hashline mode: ${trimmed} (manual override; /hashline auto to follow the model mapping)`, "info");
        return;
      }
      if (trimmed === "auto") {
        modeState.setOverride(null);
        notify(`hashline mode: ${modeState.current()} (${modeState.origin()} via model mapping)`, "info");
        return;
      }
      notify(`Unknown argument "${trimmed}". Usage: /hashline [toggle|hashline|compat|auto]`, "error");
    },
  });

  pi.on("model_select", (event) => {
    modeState.setModel(extractModelId(event.model));
  });

  pi.on("session_start", (_event, ctx) => {
    cache.clear();
    stats.applied = 0;
    stats.rejected = 0;
    stats.stale = 0;
    modeState.setModel(extractModelId(ctx.model));
  });
}
