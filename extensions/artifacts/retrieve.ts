import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ArtifactRecord, type ArtifactsConfig, ArtifactStore, formatBytes, splitLines, utf8Head } from "./spill";

interface ArtifactArgs {
  id?: string;
  offset?: number;
  limit?: number;
}

interface ToolText {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolText[];
  details: Record<string, unknown>;
}

function normalizeOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  const normalized = Math.floor(value);
  if (normalized < 1) throw new Error(`${name} must be at least 1`);
  return normalized;
}

function formatAge(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "unknown";
  const delta = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function listResult(store: ArtifactStore, ctx: ExtensionContext): ToolResult {
  const records = store.list(ctx);
  if (records.length === 0) {
    return {
      content: [{ type: "text", text: "No artifacts in this session. Oversized tool outputs are spilled here automatically." }],
      details: { count: 0 },
    };
  }
  const header = ["id", "tool", "size", "lines", "age"];
  const rows: string[][] = records.map((record) => [
    record.id,
    record.toolName,
    formatBytes(record.bytes),
    String(record.lines),
    formatAge(record.ts),
  ]);
  const widths = header.map((title, column) =>
    rows.reduce((max, row) => Math.max(max, (row[column] ?? "").length), title.length),
  );
  const renderRow = (row: string[]): string =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join("  ")
      .trimEnd();
  const table = [renderRow(header), ...rows.map(renderRow)].join("\n");
  const summary = `${records.length} artifact${records.length === 1 ? "" : "s"} in this session. Read one with {"id":"<id>"} plus optional offset and limit.`;
  return {
    content: [{ type: "text", text: `${table}\n\n${summary}` }],
    details: { count: records.length, artifacts: records },
  };
}

function windowResult(record: ArtifactRecord, text: string, offset: number, limit: number, config: ArtifactsConfig): ToolResult {
  const lines = splitLines(text);
  const total = lines.length;
  if (offset > total) {
    throw new Error(`offset ${offset} is past the end of artifact "${record.id}" (${total} line${total === 1 ? "" : "s"} total)`);
  }
  const end = Math.min(total, offset + limit - 1);
  const width = String(end).length;
  const budget = Math.max(4096, config.spillBytes);
  const out: string[] = [];
  let used = 0;
  let emittedEnd = offset - 1;
  let clipped = false;
  for (let n = offset; n <= end; n += 1) {
    let line = `${String(n).padStart(width)}: ${lines[n - 1] ?? ""}`;
    let size = Buffer.byteLength(line, "utf8") + 1;
    if (used + size > budget) {
      if (out.length === 0) {
        const head = utf8Head(line, Math.max(256, budget - 64));
        line = `${head.text} [line clipped]`;
        size = Buffer.byteLength(line, "utf8") + 1;
        out.push(line);
        used += size;
        emittedEnd = n;
      }
      clipped = true;
      break;
    }
    out.push(line);
    used += size;
    emittedEnd = n;
  }
  const remaining = total - emittedEnd;
  const headerLine = `artifact ${record.id} (${record.toolName}) — lines ${offset}-${emittedEnd} of ${total} (${formatBytes(record.bytes)} total)`;
  const notes: string[] = [];
  if (clipped && emittedEnd < end) {
    notes.push(`window clipped at ${formatBytes(budget)} before reaching the requested ${limit} lines`);
  }
  notes.push(
    remaining > 0
      ? `${remaining} line${remaining === 1 ? "" : "s"} remaining; continue with {"id":"${record.id}","offset":${emittedEnd + 1}}`
      : "end of artifact",
  );
  return {
    content: [{ type: "text", text: `${headerLine}\n\n${out.join("\n")}\n\n(${notes.join("; ")})` }],
    details: {
      id: record.id,
      toolName: record.toolName,
      offset,
      limit,
      returnedThrough: emittedEnd,
      totalLines: total,
      remainingLines: remaining,
      bytes: record.bytes,
    },
  };
}

export function registerArtifactTool(pi: ExtensionAPI, store: ArtifactStore, config: ArtifactsConfig): void {
  pi.registerTool({
    name: "artifact",
    label: "Artifact",
    description: `Read oversized tool output that was spilled to disk. Pass the artifact id from a spill banner; optional offset (1-based first line, default 1) and limit (line count, default ${config.retrieveLines}). Pass id "list" to see every artifact saved in this session with sizes, line counts, and ages.`,
    parameters: Type.Object({
      id: Type.String({ description: 'artifact id from a spill banner, or "list" to list all session artifacts' }),
      offset: Type.Optional(Type.Number({ description: "1-based line number to start from; defaults to 1" })),
      limit: Type.Optional(Type.Number({ description: `number of lines to return; defaults to ${config.retrieveLines}` })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const args = params as ArtifactArgs;
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (id === "") {
        throw new Error('artifact requires an id; pass {"id":"list"} to see available artifacts');
      }
      if (id.toLowerCase() === "list") return listResult(store, ctx);
      const record = store.get(ctx, id);
      if (!record) {
        throw new Error(`unknown artifact id "${id}"; pass {"id":"list"} to see available artifacts`);
      }
      const text = store.read(ctx, id);
      if (text === null) {
        store.remove(id);
        throw new Error(`artifact "${id}" is no longer readable (pruned or deleted); it has been removed from the index`);
      }
      const offset = normalizeOption(args.offset, 1, "offset");
      const limit = normalizeOption(args.limit, config.retrieveLines, "limit");
      return windowResult(record, text, offset, limit, config);
    },
  });
}
