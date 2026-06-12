import { Buffer } from "node:buffer";
import { isAbsolute, normalize, resolve } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompactionConfig } from "./index";
import type { SharedState } from "./promote";

export interface ToolResultLike {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: unknown[];
  isError: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isToolResult(message: unknown): message is ToolResultLike & Record<string, unknown> {
  return (
    isRecord(message) &&
    message.role === "toolResult" &&
    typeof message.toolCallId === "string" &&
    typeof message.toolName === "string" &&
    Array.isArray(message.content)
  );
}

export function messageOf(entry: unknown): Record<string, unknown> | undefined {
  if (!isRecord(entry) || entry.type !== "message") {
    return undefined;
  }
  return isRecord(entry.message) ? entry.message : undefined;
}

export function contentBytes(content: unknown): number {
  if (typeof content === "string") {
    return Buffer.byteLength(content, "utf8");
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      total += Buffer.byteLength(block.text, "utf8");
    } else if (block.type === "image" && typeof block.data === "string") {
      total += block.data.length;
    } else {
      total += estimateTokens(block) * 4;
    }
  }
  return total;
}

export function estimateTokens(value: unknown): number {
  if (typeof value === "string") {
    return Math.ceil(value.length / 4);
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized ? Math.ceil(serialized.length / 4) : 0;
  } catch {
    return 0;
  }
}

function readPathOf(args: unknown): string | undefined {
  if (!isRecord(args)) {
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

function collectReadCallPaths(entries: unknown[], normalizePath: (path: string) => string): Map<string, string> {
  const callPaths = new Map<string, string>();
  for (const entry of entries) {
    const message = messageOf(entry);
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "toolCall" || block.name !== "read" || typeof block.id !== "string") {
        continue;
      }
      const path = readPathOf(block.arguments);
      if (path) {
        callPaths.set(block.id, normalizePath(path));
      }
    }
  }
  return callPaths;
}

function newestReadKeepers(entries: unknown[], callPaths: Map<string, string>): Map<string, string> {
  const keepers = new Map<string, string>();
  for (const entry of entries) {
    const message = messageOf(entry);
    if (!message || !isToolResult(message)) {
      continue;
    }
    const path = callPaths.get(message.toolCallId);
    if (path) {
      keepers.set(path, message.toolCallId);
    }
  }
  return keepers;
}

function blankToolResult(message: ToolResultLike & Record<string, unknown>, marker: string): Record<string, unknown> {
  return { ...message, content: [{ type: "text", text: marker }], details: undefined };
}

export function registerStrategies(pi: ExtensionAPI, config: CompactionConfig, state: SharedState): void {
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      if (config.strategy !== "supersede") {
        return undefined;
      }
      if (event.signal && event.signal.aborted) {
        return undefined;
      }
      const preparation = event.preparation as unknown as Record<string, unknown>;
      if (!isRecord(preparation)) {
        return undefined;
      }
      const summarize: unknown[] = Array.isArray(preparation.messagesToSummarize)
        ? (preparation.messagesToSummarize as unknown[])
        : [];
      const prefix: unknown[] = Array.isArray(preparation.turnPrefixMessages)
        ? (preparation.turnPrefixMessages as unknown[])
        : [];
      if (summarize.length === 0 && prefix.length === 0) {
        return undefined;
      }
      const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
      const normalizePath = (path: string): string => (isAbsolute(path) ? normalize(path) : resolve(cwd, path));
      const branchEntries = Array.isArray(event.branchEntries) ? (event.branchEntries as unknown[]) : [];
      const callPaths = collectReadCallPaths(branchEntries, normalizePath);
      const keepers = newestReadKeepers(branchEntries, callPaths);
      let supersededCount = 0;
      let supersededBytes = 0;
      for (const list of [summarize, prefix]) {
        for (let i = 0; i < list.length; i++) {
          const message = list[i];
          if (!isToolResult(message)) {
            continue;
          }
          const path = callPaths.get(message.toolCallId);
          if (!path || keepers.get(path) === message.toolCallId) {
            continue;
          }
          const bytes = contentBytes(message.content);
          list[i] = blankToolResult(
            message,
            `[superseded read of ${path} elided (${formatSize(bytes)}); a newer read of this file appears later in the session]`,
          );
          supersededCount++;
          supersededBytes += bytes;
        }
      }
      const settings = preparation.settings as { keepRecentTokens?: unknown } | undefined;
      const keptTail =
        settings && typeof settings.keepRecentTokens === "number" && settings.keepRecentTokens > 0
          ? settings.keepRecentTokens
          : 20000;
      const combined = [...summarize, ...prefix];
      const tailTokens = new Array<number>(combined.length);
      let tail = keptTail;
      for (let i = combined.length - 1; i >= 0; i--) {
        tailTokens[i] = tail;
        tail += estimateTokens(combined[i]);
      }
      let droppedCount = 0;
      let droppedBytes = 0;
      for (let i = 0; i < combined.length; i++) {
        if (tailTokens[i] < config.keepRecentTokens) {
          continue;
        }
        const message = combined[i];
        if (!isToolResult(message)) {
          continue;
        }
        const bytes = contentBytes(message.content);
        if (bytes <= config.dropOverBytes) {
          continue;
        }
        const replacement = blankToolResult(
          message,
          `[oversized ${message.toolName || "tool"} result elided before compaction (${formatSize(bytes)})]`,
        );
        if (i < summarize.length) {
          summarize[i] = replacement;
        } else {
          prefix[i - summarize.length] = replacement;
        }
        droppedCount++;
        droppedBytes += bytes;
      }
      if ((supersededCount > 0 || droppedCount > 0) && ctx.hasUI) {
        ctx.ui.notify(
          `supersede: elided ${supersededCount} superseded read(s) and ${droppedCount} oversized tool result(s), ~${formatSize(supersededBytes + droppedBytes)} removed before native compaction`,
          "info",
        );
      }
      return undefined;
    } catch {
      return undefined;
    }
  });

  let preemptInFlight = false;
  let preemptLastAttempt = 0;
  pi.on("turn_end", async (_event, ctx) => {
    try {
      if (config.preemptPct <= 0 || config.preemptPct >= 100) {
        return;
      }
      if (preemptInFlight && Date.now() - preemptLastAttempt < 180000) {
        return;
      }
      const usage = ctx.getContextUsage();
      if (!usage || usage.percent === null || usage.percent === undefined) {
        return;
      }
      if (usage.percent < config.preemptPct) {
        return;
      }
      if (state.hasPromotionHeadroom(ctx)) {
        return;
      }
      preemptInFlight = true;
      preemptLastAttempt = Date.now();
      const pct = Math.round(usage.percent);
      if (ctx.hasUI) {
        ctx.ui.notify(`Context at ${pct}% (threshold ${config.preemptPct}%) — compacting preemptively`, "warning");
      }
      ctx.compact({
        onComplete: () => {
          preemptInFlight = false;
        },
        onError: (error: Error) => {
          preemptInFlight = false;
          if (ctx.hasUI) {
            ctx.ui.notify(`Preemptive compaction failed: ${error.message}`, "error");
          }
        },
      });
    } catch {
      preemptInFlight = false;
    }
  });
}
