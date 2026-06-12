import { completeSimple } from "@earendil-works/pi-ai";
import type { Context, ThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describeError, isRecord } from "./tools";
import type { SessionsConfig } from "./tools";
import { notify, showText } from "./viewer";

const BTW_SYSTEM =
  "You are answering a quick side question about an ongoing coding-agent conversation. The user shares a transcript excerpt for context, then asks a question. Answer the question directly and concisely. Do not address the conversation participants, do not continue or roleplay the conversation, and do not propose tool calls or next steps unless the question asks for them.";

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function branchEntries(ctx: ExtensionCommandContext): unknown[] {
  try {
    const branch: unknown = ctx.sessionManager.getBranch();
    if (Array.isArray(branch)) return branch;
  } catch {
    void 0;
  }
  try {
    const entries: unknown = ctx.sessionManager.getEntries();
    if (Array.isArray(entries)) return entries;
  } catch {
    void 0;
  }
  return [];
}

interface BranchPiece {
  label: string;
  text: string;
}

function pieceFrom(entry: unknown): BranchPiece | undefined {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const text = plainText(message.content).trim();
  if (text === "") return undefined;
  return { label: message.role === "user" ? "User" : "Assistant", text };
}

export function branchTranscript(ctx: ExtensionCommandContext, budget: number): string {
  const entries = branchEntries(ctx);
  const picked: string[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const piece = pieceFrom(entries[index]);
    if (piece === undefined) continue;
    const rendered = `${piece.label}: ${piece.text}`;
    if (used + rendered.length > budget) {
      if (picked.length === 0) {
        const room = Math.max(1, budget - piece.label.length - 3);
        picked.push(`${piece.label}: …${piece.text.slice(Math.max(0, piece.text.length - room))}`);
      }
      break;
    }
    picked.push(rendered);
    used += rendered.length + 2;
  }
  picked.reverse();
  return picked.join("\n\n");
}

interface ResolvedAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

async function resolveAuth(ctx: ExtensionCommandContext): Promise<ResolvedAuth> {
  const registry: unknown = ctx.modelRegistry;
  if (!isRecord(registry) || typeof registry.getApiKeyAndHeaders !== "function") return {};
  const lookup = registry.getApiKeyAndHeaders as (model: unknown) => Promise<unknown>;
  const auth: unknown = await lookup.call(registry, ctx.model);
  if (!isRecord(auth)) return {};
  if (auth.ok === false) {
    const reason = typeof auth.error === "string" && auth.error !== "" ? auth.error : "no credentials are configured for the current model";
    throw new Error(reason);
  }
  const resolved: ResolvedAuth = {};
  if (typeof auth.apiKey === "string" && auth.apiKey !== "") resolved.apiKey = auth.apiKey;
  if (isRecord(auth.headers)) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(auth.headers)) {
      if (typeof value === "string") headers[key] = value;
    }
    if (Object.keys(headers).length > 0) resolved.headers = headers;
  }
  return resolved;
}

export function registerBtwCommand(pi: ExtensionAPI, config: SessionsConfig): void {
  pi.registerCommand("btw", {
    description: "Ask the current model a side question with conversation context, without writing anything to the session",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      let question = (args ?? "").trim();
      if (question === "" && ctx.mode === "tui" && ctx.hasUI) {
        const asked = await ctx.ui.input("btw", "side question about this conversation");
        question = (asked ?? "").trim();
      }
      if (question === "") {
        notify(ctx, "Usage: /btw <question>", "warning");
        return;
      }
      const model = ctx.model;
      if (!model) {
        notify(ctx, "btw: no model is selected", "error");
        return;
      }
      if (ctx.signal?.aborted) return;
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      const tui = ctx.mode === "tui" && ctx.hasUI;
      const setSpinner = (text: string | undefined): void => {
        if (!tui) return;
        try {
          if (text === undefined) ctx.ui.setWorkingMessage();
          else ctx.ui.setWorkingMessage(text);
        } catch {
          void 0;
        }
      };
      setSpinner(`btw: asking ${model.name || model.id}…`);
      try {
        const transcript = branchTranscript(ctx, config.btwBudget);
        const intro =
          transcript === ""
            ? "There is no prior conversation in this session."
            : `Conversation transcript (oldest first, truncated to fit):\n\n${transcript}`;
        const message: UserMessage = {
          role: "user",
          content: `${intro}\n\nSide question:\n${question}`,
          timestamp: Date.now(),
        };
        const request: Context = { systemPrompt: BTW_SYSTEM, messages: [message] };
        const auth = await resolveAuth(ctx);
        const maxTokens =
          typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0
            ? Math.min(config.btwMaxTokens, model.maxTokens)
            : config.btwMaxTokens;
        let reasoning: ThinkingLevel | undefined;
        try {
          const level: string = pi.getThinkingLevel();
          if (model.reasoning === true && (PI_THINKING_LEVELS as readonly string[]).includes(level)) {
            reasoning = level as ThinkingLevel;
          }
        } catch {
          reasoning = undefined;
        }
        const response = await completeSimple(model, request, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens,
          reasoning,
          signal: controller.signal,
        });
        setSpinner(undefined);
        if (response.stopReason === "aborted") {
          notify(ctx, "btw: cancelled", "warning");
          return;
        }
        if (response.stopReason === "error") {
          throw new Error(response.errorMessage && response.errorMessage !== "" ? response.errorMessage : "the provider returned an error");
        }
        const answer = plainText(response.content).trim();
        await showText(ctx, `btw · ${model.id}`, answer === "" ? "(the model returned no text)" : answer);
      } catch (error) {
        if (controller.signal.aborted) {
          notify(ctx, "btw: cancelled", "warning");
          return;
        }
        notify(ctx, `btw: ${describeError(error)}`, "error");
      } finally {
        ctx.signal?.removeEventListener("abort", onAbort);
        setSpinner(undefined);
      }
    },
  });
}
