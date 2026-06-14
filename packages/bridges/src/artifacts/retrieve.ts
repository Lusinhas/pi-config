import { type ArtifactRecord, type ArtifactStore, type SessionSource } from "./index.ts";
import { type ArtifactsConfig, Text } from "./render.ts";

export interface ToolText {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolText[];
  details: Record<string, unknown>;
}

export interface ArtifactArgs {
  id?: string;
  offset?: number;
  limit?: number;
}

interface TextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

interface RetrievalStore {
  list(source: SessionSource): ArtifactRecord[];
  get(source: SessionSource, id: string): ArtifactRecord | undefined;
  read(source: SessionSource, id: string): string | null;
  remove(id: string): void;
}

interface SpillStore {
  attach(source: SessionSource): void;
  spillText(toolName: string, text: string): ReturnType<ArtifactStore["spillText"]>;
}

export class Retrieve {
  constructor(
    private readonly store: RetrievalStore,
    private readonly config: ArtifactsConfig,
  ) {}

  static normalizeOption(value: number | undefined, fallback: number, name: string): number {
    if (value === undefined) {
      return fallback;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number`);
    }

    const normalized = Math.floor(value);

    if (normalized < 1) {
      throw new Error(`${name} must be at least 1`);
    }

    return normalized;
  }

  execute(source: SessionSource, args: ArtifactArgs): ToolResult {
    const id = typeof args.id === "string" ? args.id.trim() : "";

    if (id === "") {
      throw new Error('artifact requires an id; pass {"id":"list"} to see available artifacts');
    }

    if (id.toLowerCase() === "list") {
      return this.buildList(source);
    }

    const record = this.store.get(source, id);

    if (!record) {
      throw new Error(`unknown artifact id "${id}"; pass {"id":"list"} to see available artifacts`);
    }

    const text = this.store.read(source, id);

    if (text === null) {
      this.store.remove(id);

      throw new Error(`artifact "${id}" is no longer readable (pruned or deleted); it has been removed from the index`);
    }

    const offset = Retrieve.normalizeOption(args.offset, 1, "offset");
    const limit = Retrieve.normalizeOption(args.limit, this.config.retrieveLines, "limit");

    return this.buildWindow(record, text, offset, limit);
  }

  buildList(source: SessionSource): ToolResult {
    const records = this.store.list(source);

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
      Text.formatBytes(record.bytes),
      String(record.lines),
      Text.formatAge(record.ts),
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

  buildWindow(record: ArtifactRecord, text: string, offset: number, limit: number): ToolResult {
    const lines = Text.splitLines(text);
    const total = lines.length;

    if (offset > total) {
      throw new Error(`offset ${offset} is past the end of artifact "${record.id}" (${total} line${total === 1 ? "" : "s"} total)`);
    }

    const end = Math.min(total, offset + limit - 1);
    const width = String(end).length;
    const budget = Math.max(4096, this.config.spillBytes);
    const out: string[] = [];
    let used = 0;
    let emittedEnd = offset - 1;
    let clipped = false;

    for (let n = offset; n <= end; n += 1) {
      let line = `${String(n).padStart(width)}: ${lines[n - 1] ?? ""}`;
      let size = Buffer.byteLength(line, "utf8") + 1;

      if (used + size > budget) {
        if (out.length === 0) {
          const head = Text.utf8Head(line, Math.max(256, budget - 64));
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
    const headerLine = `artifact ${record.id} (${record.toolName}) — lines ${offset}-${emittedEnd} of ${total} (${Text.formatBytes(record.bytes)} total)`;
    const notes: string[] = [];

    if (clipped && emittedEnd < end) {
      notes.push(`window clipped at ${Text.formatBytes(budget)} before reaching the requested ${limit} lines`);
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
}

export class Spiller {
  private readonly skip: Set<string>;

  constructor(
    private readonly store: SpillStore,
    private readonly config: ArtifactsConfig,
  ) {
    this.skip = new Set(config.skipTools);
  }

  static isTextBlock(block: unknown): block is TextBlock {
    return (
      typeof block === "object" &&
      block !== null &&
      !Array.isArray(block) &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    );
  }

  static toolName(value: unknown): string {
    return typeof value === "string" ? value : "unknown";
  }

  decide(toolName: string, content: unknown, source: SessionSource): { content: unknown[] } | undefined {
    if (this.skip.has(toolName)) {
      return undefined;
    }

    if (!Array.isArray(content)) {
      return undefined;
    }

    this.store.attach(source);
    let changed = false;

    const next = content.map((block) => {
      if (!Spiller.isTextBlock(block)) {
        return block;
      }

      if (Buffer.byteLength(block.text, "utf8") <= this.config.spillBytes) {
        return block;
      }

      const record = this.store.spillText(toolName, block.text);

      if (!record) {
        return block;
      }

      changed = true;

      return { type: "text" as const, text: Text.buildReplacement(block.text, record, this.config) };
    });

    if (!changed) {
      return undefined;
    }

    return { content: next };
  }
}
