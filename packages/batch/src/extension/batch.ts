import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  BatchDispatcher,
  type BatchCall,
  type BatchOutcome,
  type CallResult,
  type PermissionBroker,
  type TodoHandle,
} from "../dispatch/dispatch.ts";
import { SdkCoreTools } from "../dispatch/sdk.ts";
import type { BatchConfig } from "./config.ts";

const BROKER_KEY = Symbol.for("piconfig.permissions.broker");
const TODO_KEY = Symbol.for("piconfig.todo");

interface ToolText {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolText[];
  details: BatchOutcome;
}

const TOOL_DESCRIPTION =
  "Run several tool calls in a single request. Provide calls[] of {tool, input}; each runs in order and is authorized individually by the permission system. Batchable tools: read, write, edit, grep, find, ls, bash, todo. Use it to cut round-trips when firing independent or naturally sequenced calls.";

const batchParameters = Type.Object({
  calls: Type.Array(
    Type.Object({
      tool: Type.String({ description: "tool name: read, write, edit, grep, find, ls, bash, or todo" }),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "arguments object passed to the tool" })),
    }),
    { description: "tool calls to run sequentially, in order", minItems: 1 },
  ),
});

const STATUS_MARK: Record<CallResult["status"], string> = {
  ok: "✓",
  blocked: "✗ blocked",
  error: "✗ error",
};

export class BatchRegistrar {
  private readonly dispatcher: BatchDispatcher;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly config: BatchConfig,
  ) {
    this.dispatcher = new BatchDispatcher({
      resolveBroker: () => BatchRegistrar.resolveBroker(),
      resolveTodo: () => BatchRegistrar.resolveTodo(),
      coreTools: new SdkCoreTools(),
      allowed: new Set<string>(config.tools),
    });
  }

  register(): void {
    this.pi.registerTool({
      name: "batch",
      label: "Batch",
      description: TOOL_DESCRIPTION,
      promptSnippet: "batch — run multiple tool calls (read/write/edit/grep/find/ls/bash/todo) in one request",
      promptGuidelines: [
        "Use batch to group independent or naturally sequenced calls (several reads, or a write then a read) into one request.",
        "Each sub-call is permission-checked separately; a denied call is skipped and the remaining calls still run.",
        "Only read, write, edit, grep, find, ls, bash, and todo can be batched; call any other tool directly.",
      ],
      parameters: batchParameters,
      execute: (_toolCallId, params, _signal, _onUpdate, ctx): Promise<ToolResult> =>
        this.execute(params as Record<string, unknown>, ctx),
    });
  }

  private async execute(params: Record<string, unknown>, ctx: ExtensionContext): Promise<ToolResult> {
    const calls = Array.isArray(params.calls) ? (params.calls as BatchCall[]) : [];

    if (calls.length === 0) {
      return BatchRegistrar.text("batch: no calls provided");
    }

    if (calls.length > this.config.maxCalls) {
      return BatchRegistrar.text(`batch: too many calls (${calls.length} > limit ${this.config.maxCalls})`);
    }

    const outcome = await this.dispatcher.run(calls, ctx);

    return this.format(outcome);
  }

  private format(outcome: BatchOutcome): ToolResult {
    const ok = outcome.results.filter((result) => result.status === "ok").length;
    const blocked = outcome.results.filter((result) => result.status === "blocked").length;
    const errored = outcome.results.filter((result) => result.status === "error").length;

    const lines: string[] = [
      `batch: ${outcome.results.length} call${outcome.results.length === 1 ? "" : "s"} (${ok} ok, ${blocked} blocked, ${errored} error)`,
    ];

    for (const result of outcome.results) {
      lines.push("");
      lines.push(`— [${result.index + 1}] ${result.tool} ${STATUS_MARK[result.status]}`);
      lines.push(result.text);
    }

    return { content: [{ type: "text", text: lines.join("\n") }], details: outcome };
  }

  private static text(message: string): ToolResult {
    return { content: [{ type: "text", text: message }], details: { results: [] } };
  }

  private static resolveBroker(): PermissionBroker | undefined {
    const candidate = BatchRegistrar.host()[BROKER_KEY];

    if (BatchRegistrar.isRecord(candidate) && typeof candidate.decide === "function") {
      return candidate as unknown as PermissionBroker;
    }

    return undefined;
  }

  private static resolveTodo(): TodoHandle | undefined {
    const candidate = BatchRegistrar.host()[TODO_KEY];

    if (BatchRegistrar.isRecord(candidate) && typeof candidate.execute === "function") {
      return candidate as unknown as TodoHandle;
    }

    return undefined;
  }

  private static host(): Record<symbol, unknown> {
    return globalThis as unknown as Record<symbol, unknown>;
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
