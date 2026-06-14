import { Text } from "./text.ts";

export type GoalStatus = "met" | "unmet" | "blocked";

export type VerdictSource = "judge" | "marker" | "todos";

export interface GoalVerdict {
  status: GoalStatus;
  reason: string;
  source: VerdictSource;
}

export interface JudgeRegistry {
  find(provider: string, modelId: string): unknown;
  getApiKey?(model: unknown, sessionId?: string): Promise<string | undefined>;
  getApiKeyAndHeaders?(model: unknown): Promise<unknown>;
}

export interface JudgeAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface CompleteResponse {
  content: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

export interface CompleteOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface CompleteRequest {
  messages: Array<{ role: string; content: string; timestamp: number }>;
}

export type CompleteSimple = (
  model: unknown,
  request: CompleteRequest,
  options: CompleteOptions,
) => Promise<CompleteResponse>;

export interface JudgeRequest {
  condition: string;
  lastText: string;
  modelRef: string;
  timeoutMs: number;
  maxChars: number;
  metMarker: string;
  registry: JudgeRegistry;
  signal?: AbortSignal;
}

const REASON_CAP = 400;

const DEFAULT_TIMEOUT_MS = 30000;

export class Verdict {
  static readonly instructions = [
    "You judge whether a coding agent has satisfied a completion condition.",
    "Below are the condition and the agent's most recent message.",
    "Answer with exactly two lines:",
    "VERDICT: met | unmet | blocked",
    "REASON: one short sentence explaining the verdict",
    "Use met only when the condition is clearly and fully satisfied.",
    "Use blocked when the condition is impossible to satisfy, the agent declared it cannot proceed, or it is stuck repeating the same failing approach.",
    "Otherwise use unmet.",
  ].join("\n");

  static marker(lastText: string, metMarker: string, cause: string): GoalVerdict {

    if (metMarker.length > 0 && lastText.includes(metMarker)) {

      return {
        status: "met",
        reason: `found ${metMarker} in the last assistant message (${cause})`,
        source: "marker",
      };
    }

    return {
      status: "unmet",
      reason: `no ${metMarker} marker in the last assistant message (${cause})`,
      source: "marker",
    };
  }

  static parse(reply: string): GoalVerdict | undefined {
    const trimmed = reply.trim();

    if (!trimmed) {
      return undefined;
    }

    let status: GoalStatus | undefined;
    const tagged = /verdict\s*[:\-]?\s*\**\s*(unmet|blocked|met)\b/i.exec(trimmed);

    if (tagged) {
      status = tagged[1].toLowerCase() as GoalStatus;
    } else {
      const lower = trimmed.toLowerCase();

      if (/\bblocked\b/.test(lower)) {
        status = "blocked";
      } else if (/\bunmet\b/.test(lower)) {
        status = "unmet";
      } else if (/\bmet\b/.test(lower)) {
        status = /\bnot\b/.test(lower) ? "unmet" : "met";
      }
    }

    if (!status) {
      return undefined;
    }

    const reasonMatch = /reason\s*[:\-]?\s*\**\s*([\s\S]+)/i.exec(trimmed);
    let reason = (reasonMatch ? reasonMatch[1] : trimmed).trim();

    if (reason.length > REASON_CAP) {
      reason = `${reason.slice(0, REASON_CAP)}…`;
    }

    return { status, reason: reason || "no reason given", source: "judge" };
  }

  static clipTail(text: string, maxChars: number): string {

    if (maxChars <= 0 || text.length <= maxChars) {
      return text;
    }

    return `[earlier output truncated]\n${text.slice(text.length - maxChars)}`;
  }
}

export class Judge {
  #complete: CompleteSimple;

  constructor(complete: CompleteSimple) {
    this.#complete = complete;
  }

  async judge(request: JudgeRequest): Promise<GoalVerdict> {

    if (request.signal?.aborted) {
      return Verdict.marker(request.lastText, request.metMarker, "judge aborted");
    }

    const model = this.resolveModel(request.modelRef, request.registry);

    if (!model) {
      return Verdict.marker(request.lastText, request.metMarker, `judge model "${request.modelRef}" unavailable`);
    }

    const auth = await this.resolveAuth(request.registry, model);
    const timeoutMs = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      const body = Verdict.clipTail(request.lastText, request.maxChars).trim() || "(the agent produced no text output)";
      const prompt = `${Verdict.instructions}\n\nCompletion condition:\n${request.condition}\n\nLast assistant message:\n${body}`;
      const response = await this.#complete(
        model,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal },
      );

      if (response.stopReason === "error" || response.stopReason === "aborted") {
        const cause =
          typeof response.errorMessage === "string" && response.errorMessage
            ? `judge call failed: ${response.errorMessage}`
            : `judge call ${response.stopReason}`;

        return Verdict.marker(request.lastText, request.metMarker, cause);
      }

      const parsed = Verdict.parse(Text.flatten(response.content));

      if (parsed) {
        return parsed;
      }

      return Verdict.marker(request.lastText, request.metMarker, "judge reply was unparsable");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return Verdict.marker(request.lastText, request.metMarker, `judge call failed: ${message}`);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  resolveModel(modelRef: string, registry: JudgeRegistry): unknown {
    const separator = modelRef.indexOf("/");

    if (separator < 1 || separator >= modelRef.length - 1) {
      return undefined;
    }

    const provider = modelRef.slice(0, separator).trim();
    const modelId = modelRef.slice(separator + 1).trim();

    if (!provider || !modelId) {
      return undefined;
    }

    let found: unknown;

    try {
      found = registry.find(provider, modelId);
    } catch {
      found = undefined;
    }

    if (!found || typeof found !== "object") {
      return undefined;
    }

    return found;
  }

  async resolveAuth(registry: JudgeRegistry, model: unknown): Promise<JudgeAuth> {

    if (typeof registry.getApiKey === "function") {

      try {
        return { apiKey: await registry.getApiKey(model) };
      } catch {
        return {};
      }
    }

    if (typeof registry.getApiKeyAndHeaders === "function") {

      try {
        const auth = await registry.getApiKeyAndHeaders(model);

        if (!auth || typeof auth !== "object") {
          return {};
        }

        const candidate = auth as { ok?: unknown; apiKey?: unknown; headers?: unknown };

        if (candidate.ok !== true) {
          return {};
        }

        const result: JudgeAuth = {};

        if (typeof candidate.apiKey === "string" && candidate.apiKey) {
          result.apiKey = candidate.apiKey;
        }

        if (candidate.headers && typeof candidate.headers === "object" && !Array.isArray(candidate.headers)) {
          const headers: Record<string, string> = {};

          for (const [key, value] of Object.entries(candidate.headers as Record<string, unknown>)) {

            if (typeof value === "string") {
              headers[key] = value;
            }
          }

          if (Object.keys(headers).length > 0) {
            result.headers = headers;
          }
        }

        return result;
      } catch {
        return {};
      }
    }

    return {};
  }
}
