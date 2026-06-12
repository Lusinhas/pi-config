import { completeSimple } from "@earendil-works/pi-ai";

type JudgeModel = Parameters<typeof completeSimple>[0];

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

interface JudgeAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

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

const INSTRUCTIONS = [
  "You judge whether a coding agent has satisfied a completion condition.",
  "Below are the condition and the agent's most recent message.",
  "Answer with exactly two lines:",
  "VERDICT: met | unmet | blocked",
  "REASON: one short sentence explaining the verdict",
  "Use met only when the condition is clearly and fully satisfied.",
  "Use blocked when the condition is impossible to satisfy, the agent declared it cannot proceed, or it is stuck repeating the same failing approach.",
  "Otherwise use unmet.",
].join("\n");

function markerVerdict(lastText: string, metMarker: string, cause: string): GoalVerdict {
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

function clipTail(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  return `[earlier output truncated]\n${text.slice(text.length - maxChars)}`;
}

function resolveModel(modelRef: string, registry: JudgeRegistry): JudgeModel | undefined {
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
  return found as JudgeModel;
}

async function resolveAuth(registry: JudgeRegistry, model: JudgeModel): Promise<JudgeAuth> {
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

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const candidate = block as { type?: unknown; text?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        parts.push(candidate.text);
      }
    }
  }
  return parts.join("\n");
}

function parseVerdict(reply: string): GoalVerdict | undefined {
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
  if (reason.length > 400) {
    reason = `${reason.slice(0, 400)}…`;
  }
  return { status, reason: reason || "no reason given", source: "judge" };
}

export async function judgeGoal(request: JudgeRequest): Promise<GoalVerdict> {
  if (request.signal?.aborted) {
    return markerVerdict(request.lastText, request.metMarker, "judge aborted");
  }
  const model = resolveModel(request.modelRef, request.registry);
  if (!model) {
    return markerVerdict(request.lastText, request.metMarker, `judge model "${request.modelRef}" unavailable`);
  }
  const auth = await resolveAuth(request.registry, model);
  const timeoutMs = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = (): void => controller.abort();
  request.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const body = clipTail(request.lastText, request.maxChars).trim() || "(the agent produced no text output)";
    const prompt = `${INSTRUCTIONS}\n\nCompletion condition:\n${request.condition}\n\nLast assistant message:\n${body}`;
    const response = await completeSimple(
      model,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const cause = response.errorMessage ? `judge call failed: ${response.errorMessage}` : `judge call ${response.stopReason}`;
      return markerVerdict(request.lastText, request.metMarker, cause);
    }
    const parsed = parseVerdict(textOf(response.content));
    if (parsed) {
      return parsed;
    }
    return markerVerdict(request.lastText, request.metMarker, "judge reply was unparsable");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return markerVerdict(request.lastText, request.metMarker, `judge call failed: ${message}`);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", forwardAbort);
  }
}
