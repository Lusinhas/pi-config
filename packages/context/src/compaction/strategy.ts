import { isAbsolute, normalize, resolve } from "node:path";
import { Messages, type ToolResultMessage } from "./index.ts";

export interface SupersedeOptions {
  keepRecentTokens: number;
  dropOverBytes: number;
}

export interface SupersedeInput {
  summarize: unknown[];
  prefix: unknown[];
  branchEntries: unknown[];
  cwd: string;
  settingsKeepRecentTokens: number | undefined;
}

export interface SupersedeResult {
  supersededCount: number;
  supersededBytes: number;
  droppedCount: number;
  droppedBytes: number;
  notifyText: string | undefined;
}

interface ReadIndex {
  callPaths: Map<string, string>;
  keepers: Map<string, string>;
}

export class CompactionWindow {
  constructor(
    private readonly summarize: unknown[],
    private readonly prefix: unknown[],
  ) {}

  get length(): number {
    return this.summarize.length + this.prefix.length;
  }

  at(index: number): unknown {
    return index < this.summarize.length ? this.summarize[index] : this.prefix[index - this.summarize.length];
  }

  set(index: number, value: unknown): void {
    if (index < this.summarize.length) {
      this.summarize[index] = value;
    } else {
      this.prefix[index - this.summarize.length] = value;
    }
  }
}

export class Supersede {
  constructor(
    private readonly messages: Messages,
    private readonly options: SupersedeOptions,
  ) {}

  normalizePath(path: string, cwd: string): string {
    return isAbsolute(path) ? normalize(path) : resolve(cwd, path);
  }

  readPathOf(args: unknown): string | undefined {
    if (!this.messages.isRecord(args)) {
      return undefined;
    }

    for (const key of ["path", "file_path", "filePath", "file"]) {
      const value = args[key];

      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }

    return undefined;
  }

  indexReads(entries: unknown[], cwd: string): ReadIndex {
    const callPaths = new Map<string, string>();
    const keepers = new Map<string, string>();

    for (const entry of entries) {
      const message = this.messages.messageOf(entry);

      if (!message) {
        continue;
      }

      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (
            !this.messages.isRecord(block) ||
            block.type !== "toolCall" ||
            block.name !== "read" ||
            typeof block.id !== "string"
          ) {
            continue;
          }

          const path = this.readPathOf(block.arguments);

          if (path) {
            callPaths.set(block.id, this.normalizePath(path, cwd));
          }
        }

        continue;
      }

      if (this.messages.isToolResult(message)) {
        const path = callPaths.get(message.toolCallId);

        if (path) {
          keepers.set(path, message.toolCallId);
        }
      }
    }

    return { callPaths, keepers };
  }

  blank(message: ToolResultMessage, marker: string): Record<string, unknown> {
    return { ...message, content: [{ type: "text", text: marker }], details: undefined };
  }

  transform(input: SupersedeInput): SupersedeResult {
    const index = this.indexReads(input.branchEntries, input.cwd);
    const window = new CompactionWindow(input.summarize, input.prefix);

    let supersededCount = 0;
    let supersededBytes = 0;

    for (let i = 0; i < window.length; i++) {
      const message = window.at(i);

      if (!this.messages.isToolResult(message)) {
        continue;
      }

      const path = index.callPaths.get(message.toolCallId);

      if (!path || index.keepers.get(path) === message.toolCallId) {
        continue;
      }

      const bytes = this.messages.contentBytes(message.content);

      window.set(
        i,
        this.blank(
          message,
          `[superseded read of ${path} elided (${this.messages.formatSize(bytes)}); a newer read of this file appears later in the session]`,
        ),
      );
      supersededCount++;
      supersededBytes += bytes;
    }

    const keptTail =
      typeof input.settingsKeepRecentTokens === "number" && input.settingsKeepRecentTokens > 0
        ? input.settingsKeepRecentTokens
        : 20000;
    const tailTokens = new Array<number>(window.length);
    let tail = keptTail;

    for (let i = window.length - 1; i >= 0; i--) {
      tailTokens[i] = tail;
      tail += this.messages.estimateTokens(window.at(i));
    }

    let droppedCount = 0;
    let droppedBytes = 0;

    for (let i = 0; i < window.length; i++) {
      if (tailTokens[i] < this.options.keepRecentTokens) {
        continue;
      }

      const message = window.at(i);

      if (!this.messages.isToolResult(message)) {
        continue;
      }

      const bytes = this.messages.contentBytes(message.content);

      if (bytes <= this.options.dropOverBytes) {
        continue;
      }

      window.set(
        i,
        this.blank(
          message,
          `[oversized ${message.toolName || "tool"} result elided before compaction (${this.messages.formatSize(bytes)})]`,
        ),
      );
      droppedCount++;
      droppedBytes += bytes;
    }

    const notifyText =
      supersededCount > 0 || droppedCount > 0
        ? `supersede: elided ${supersededCount} superseded read(s) and ${droppedCount} oversized tool result(s), ~${this.messages.formatSize(supersededBytes + droppedBytes)} removed before native compaction`
        : undefined;

    return { supersededCount, supersededBytes, droppedCount, droppedBytes, notifyText };
  }
}

export interface ShakeEstimate {
  count: number;
  bytes: number;
}

export interface ShakeTransform {
  messages: unknown[];
  count: number;
  saved: number;
}

export class Shake {
  constructor(
    private readonly messages: Messages,
    private readonly overBytes: number,
  ) {}

  estimateLiveBranch(entries: unknown[]): ShakeEstimate {
    let start = 0;

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];

      if (this.messages.isRecord(entry) && entry.type === "compaction") {
        start = i + 1;
        break;
      }
    }

    let count = 0;
    let bytes = 0;

    for (let i = start; i < entries.length; i++) {
      const message = this.messages.messageOf(entries[i]);

      if (!message || !this.messages.isToolResult(message)) {
        continue;
      }

      const size = this.messages.contentBytes(message.content);

      if (size > this.overBytes) {
        count++;
        bytes += size;
      }
    }

    return { count, bytes };
  }

  transformRequest(incoming: unknown[]): ShakeTransform {
    const outgoing: unknown[] = [];
    let count = 0;
    let saved = 0;

    for (const message of incoming) {
      if (this.messages.isToolResult(message)) {
        const bytes = this.messages.contentBytes(message.content);

        if (bytes > this.overBytes) {
          count++;
          saved += bytes;
          outgoing.push({
            ...message,
            content: [
              {
                type: "text",
                text: `[tool output from ${message.toolName} elided by /shake: ${this.messages.formatSize(bytes)} (${bytes} bytes)]`,
              },
            ],
            details: undefined,
          });
          continue;
        }
      }

      outgoing.push(message);
    }

    return { messages: outgoing, count, saved };
  }

  tokensFor(bytes: number): number {
    return Math.ceil(bytes / 4);
  }
}
