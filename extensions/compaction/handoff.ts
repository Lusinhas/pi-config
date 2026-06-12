import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { complete } from "@earendil-works/pi-ai";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionConfig } from "./index";
import type { SharedState } from "./promote";
import { contentBytes, isRecord, isToolResult, messageOf } from "./strategies";

const HANDOFFSYSTEM = `You write handoff documents that let a fresh coding-agent session continue work seamlessly.
Produce a markdown document with exactly these sections:
## Goal
What the user is ultimately trying to achieve.
## Current state
What has been done so far, which files were created or modified, what works and what does not.
## Decisions
Choices made and their rationale, including approaches that were considered and rejected.
## Open items
Remaining work, known issues, and concrete next steps.
Be specific: include file paths, command names, identifiers, and error messages where they matter.
The document must be self-contained; the reader has no access to the previous session.
Output only the document, with no preamble or closing remarks.`;

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, Math.floor(max * 0.7));
  const tailStart = text.length - Math.floor(max * 0.2);
  return `${head}\n[...${text.length - max} chars clipped...]\n${text.slice(tailStart)}`;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function renderMessage(message: Record<string, unknown>): string {
  const role = typeof message.role === "string" ? message.role : "";
  if (role === "user") {
    const text = textOfContent(message.content).trim();
    return text ? `USER:\n${clip(text, 4000)}` : "";
  }
  if (role === "assistant") {
    const parts: string[] = [];
    const text = textOfContent(message.content).trim();
    if (text) {
      parts.push(clip(text, 4000));
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string") {
          let args = "";
          try {
            args = JSON.stringify(block.arguments ?? {});
          } catch {
            args = "{}";
          }
          parts.push(`TOOL CALL ${block.name}(${clip(args, 300)})`);
        }
      }
    }
    return parts.length > 0 ? `ASSISTANT:\n${parts.join("\n")}` : "";
  }
  if (isToolResult(message)) {
    const text = textOfContent(message.content).trim();
    const flag = message.isError ? " (error)" : "";
    return text ? `TOOL RESULT ${message.toolName}${flag}:\n${clip(text, 1200)}` : "";
  }
  if (role === "developer") {
    const text = textOfContent(message.content).trim();
    return text ? `SYSTEM NOTE:\n${clip(text, 1500)}` : "";
  }
  return "";
}

function serializeRecentEntries(entries: unknown[], maxChars: number): string {
  const rendered: string[] = [];
  for (const entry of entries) {
    const message = messageOf(entry);
    if (!message) {
      continue;
    }
    const text = renderMessage(message);
    if (text) {
      rendered.push(text);
    }
  }
  const kept: string[] = [];
  let total = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const piece = rendered[i];
    if (kept.length > 0 && total + piece.length > maxChars) {
      break;
    }
    kept.push(piece);
    total += piece.length;
  }
  return kept.reverse().join("\n\n");
}

function estimateShake(entries: unknown[], threshold: number): { count: number; bytes: number } {
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isRecord(entry) && entry.type === "compaction") {
      start = i + 1;
      break;
    }
  }
  let count = 0;
  let bytes = 0;
  for (let i = start; i < entries.length; i++) {
    const message = messageOf(entries[i]);
    if (!message || !isToolResult(message)) {
      continue;
    }
    const size = contentBytes(message.content);
    if (size > threshold) {
      count++;
      bytes += size;
    }
  }
  return { count, bytes };
}

async function resolveAuth(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
  const registry = ctx.modelRegistry as unknown as {
    getApiKeyAndHeaders?: (
      model: NonNullable<ExtensionContext["model"]>,
    ) => Promise<{ ok: boolean; error?: string; apiKey?: string; headers?: Record<string, string> }>;
    getApiKey?: (model: NonNullable<ExtensionContext["model"]>) => Promise<string | undefined>;
  };
  if (typeof registry.getApiKeyAndHeaders === "function") {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(auth.error || "model authentication failed");
    }
    return { apiKey: auth.apiKey, headers: auth.headers };
  }
  if (typeof registry.getApiKey === "function") {
    return { apiKey: await registry.getApiKey(model) };
  }
  return {};
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function registerHandoff(pi: ExtensionAPI, config: CompactionConfig, state: SharedState): void {
  const helpText = [
    `/handoff [instructions] — ask the current model to write a handoff document (goal, current state, decisions, open items) over the recent session, save it to ${config.handoffPath}, then optionally start a fresh session opened with it.`,
    `/shake — arm a one-shot context transformer that, on the next request, blanks tool outputs larger than ${formatSize(config.shakeOverBytes)} (shakeOverBytes) with an elided marker plus byte count, and reports the estimated savings.`,
    `Compaction strategy "${config.strategy}": on session_before_compact the supersede strategy blanks all but the newest read result per file and drops tool results over ${formatSize(config.dropOverBytes)} (dropOverBytes) that fall outside the most recent ~${config.keepRecentTokens} tokens (keepRecentTokens); the handler then returns undefined, which chains into pi's native compaction so the remaining, leaner context is summarized normally.`,
    `Preemptive compaction runs ctx.compact() when context usage crosses ${config.preemptPct}% (preemptPct). Context promotion switches to a larger-window model from promotion.ladder at ${config.promotePct}% (promotePct) instead of compacting, and the original model is restored on /handoff or a new session.`,
  ].join("\n");

  let shakeArmed = false;

  pi.on("session_start", async () => {
    shakeArmed = false;
  });

  pi.on("context", async (event, ctx) => {
    if (!shakeArmed) {
      return undefined;
    }
    shakeArmed = false;
    try {
      const incoming = Array.isArray(event.messages) ? (event.messages as unknown[]) : [];
      const outgoing: unknown[] = [];
      let count = 0;
      let saved = 0;
      for (const message of incoming) {
        if (isToolResult(message)) {
          const bytes = contentBytes(message.content);
          if (bytes > config.shakeOverBytes) {
            count++;
            saved += bytes;
            outgoing.push({
              ...message,
              content: [
                {
                  type: "text",
                  text: `[tool output from ${message.toolName} elided by /shake: ${formatSize(bytes)} (${bytes} bytes)]`,
                },
              ],
              details: undefined,
            });
            continue;
          }
        }
        outgoing.push(message);
      }
      if (count === 0) {
        return undefined;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(
          `/shake elided ${count} tool result(s) from this request, saving ~${formatSize(saved)} (≈${Math.ceil(saved / 4)} tokens)`,
          "info",
        );
      }
      return { messages: outgoing as typeof event.messages };
    } catch {
      return undefined;
    }
  });

  pi.registerCommand("shake", {
    description: `Strip heavy tool results from the live context: blanks tool outputs over ${formatSize(config.shakeOverBytes)} on the next request and reports estimated savings`,
    handler: async (_args, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      const estimate = estimateShake(branch as unknown[], config.shakeOverBytes);
      if (estimate.count === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Nothing to shake: no tool results over ${formatSize(config.shakeOverBytes)} in the live context`, "info");
        }
        return;
      }
      shakeArmed = true;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Shake armed: the next request will elide ${estimate.count} tool result(s) over ${formatSize(config.shakeOverBytes)}, estimated savings ~${formatSize(estimate.bytes)} (≈${Math.ceil(estimate.bytes / 4)} tokens)`,
          "info",
        );
      }
    },
  });

  pi.registerCommand("handoff", {
    description: `Write a handoff document to ${config.handoffPath} and optionally start a fresh session from it; run "/handoff help" for strategy details (supersede returns undefined to chain into native compaction)`,
    handler: async (args, ctx) => {
      const instructions = args.trim();
      if (instructions === "help" || instructions === "--help") {
        if (ctx.hasUI) {
          ctx.ui.notify(helpText, "info");
        }
        return;
      }
      const model = ctx.model;
      if (!model) {
        if (ctx.hasUI) {
          ctx.ui.notify("No model selected; cannot generate a handoff document", "error");
        }
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const serialized = serializeRecentEntries(branch as unknown[], config.handoffChars);
      if (!serialized) {
        if (ctx.hasUI) {
          ctx.ui.notify("Nothing to hand off: the session has no conversation yet", "warning");
        }
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      const promptSections: string[] = [];
      if (instructions) {
        promptSections.push(`The user gave these instructions for the handoff: ${instructions}`);
      }
      promptSections.push(`Write the handoff document for the session below.\n\n<session>\n${serialized}\n</session>`);
      let doc = "";
      if (ctx.hasUI) {
        ctx.ui.setStatus("compaction", "generating handoff document");
      }
      try {
        const auth = await resolveAuth(ctx, model);
        const response = await complete(
          model,
          {
            systemPrompt: HANDOFFSYSTEM,
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: promptSections.join("\n\n") }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            maxTokens: config.handoffMaxTokens,
            signal: ctx.signal,
          },
        );
        if (response.stopReason === "aborted") {
          if (ctx.hasUI) {
            ctx.ui.notify("Handoff generation cancelled", "info");
          }
          return;
        }
        if (response.stopReason === "error") {
          throw new Error(response.errorMessage || "model returned an error");
        }
        doc = extractText(response.content);
        if (!doc) {
          throw new Error("model returned an empty handoff document");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) {
          ctx.ui.notify(`Handoff generation failed: ${message}`, "error");
        }
        return;
      } finally {
        if (ctx.hasUI) {
          ctx.ui.setStatus("compaction", undefined);
        }
      }
      const target = isAbsolute(config.handoffPath) ? config.handoffPath : resolve(ctx.cwd, config.handoffPath);
      try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `${doc}\n`, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) {
          ctx.ui.notify(`Failed to write ${target}: ${message}`, "error");
        }
        return;
      }
      await state.restoreOriginalModel(ctx);
      if (!ctx.hasUI) {
        return;
      }
      ctx.ui.notify(`Handoff document written to ${config.handoffPath}`, "info");
      const startFresh = await ctx.ui.confirm(
        "Handoff written",
        `Start a fresh session opened with ${config.handoffPath} as its first context?`,
      );
      if (!startFresh) {
        return;
      }
      const opening = `Continuing work from a previous session. The handoff document below was saved to ${config.handoffPath}.\n\n${doc}`;
      let seeded = false;
      const result = await ctx.newSession({
        parentSession: sessionFile,
        setup: async (sessionManager) => {
          const manager = sessionManager as unknown as { appendMessage?: (message: unknown) => unknown };
          if (typeof manager.appendMessage === "function") {
            manager.appendMessage({
              role: "user",
              content: [{ type: "text", text: opening }],
              timestamp: Date.now(),
            });
            seeded = true;
          }
        },
        withSession: async (fresh) => {
          if (seeded) {
            fresh.ui.notify("Fresh session started with the handoff document as opening context", "info");
            return;
          }
          fresh.ui.setEditorText(opening);
          fresh.ui.notify("Fresh session started; handoff document placed in the editor — submit to seed the context", "info");
        },
      });
      if (result.cancelled) {
        ctx.ui.notify("New session cancelled; handoff document is still saved", "info");
      }
    },
  });
}
