import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type CoreToolName = "read" | "write" | "edit" | "grep" | "find" | "ls" | "bash";

export const CORE_TOOL_NAMES: readonly CoreToolName[] = ["read", "write", "edit", "grep", "find", "ls", "bash"];

export const BATCHABLE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([...CORE_TOOL_NAMES, "todo"]);

export interface PermissionDecision {
  block?: boolean;
  reason?: string;
}

export interface PermissionBroker {
  decide(toolName: string, input: unknown, origin: string): Promise<PermissionDecision | undefined>;
}

export interface ToolContent {
  type: string;
  text?: string;
}

export interface ToolOutcome {
  content: ToolContent[];
}

export interface TodoHandle {
  execute(params: Record<string, unknown>, ctx: ExtensionContext): Promise<ToolOutcome>;
}

export interface ExecutableTool {
  prepareArguments?: (args: unknown) => unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<ToolOutcome>;
}

export interface CoreToolProvider {
  build(name: CoreToolName, cwd: string): ExecutableTool;
}

export interface BatchCall {
  tool: string;
  input?: Record<string, unknown>;
}

export type CallStatus = "ok" | "blocked" | "error";

export interface CallResult {
  index: number;
  tool: string;
  status: CallStatus;
  text: string;
}

export interface BatchOutcome {
  results: CallResult[];
}

export interface DispatchDeps {
  resolveBroker(): PermissionBroker | undefined;
  resolveTodo(): TodoHandle | undefined;
  coreTools: CoreToolProvider;
  allowed: ReadonlySet<string>;
}

export class BatchDispatcher {
  constructor(private readonly deps: DispatchDeps) {}

  async run(calls: BatchCall[], ctx: ExtensionContext): Promise<BatchOutcome> {
    const results: CallResult[] = [];

    for (let index = 0; index < calls.length; index += 1) {
      results.push(await this.runOne(index, calls[index], ctx));
    }

    return { results };
  }

  private async runOne(index: number, call: BatchCall, ctx: ExtensionContext): Promise<CallResult> {
    const tool = typeof call.tool === "string" ? call.tool.trim() : "";
    const input = BatchDispatcher.isRecord(call.input) ? call.input : {};

    if (!this.deps.allowed.has(tool)) {
      return { index, tool, status: "error", text: `tool "${tool || "(missing)"}" is not available for batching` };
    }

    const broker = this.deps.resolveBroker();

    if (!broker) {
      return { index, tool, status: "error", text: "permissions broker unavailable; batched calls cannot be authorized" };
    }

    let decision: PermissionDecision | undefined;

    try {
      decision = await broker.decide(tool, input, "");
    } catch (error) {
      return { index, tool, status: "error", text: `permission check failed: ${BatchDispatcher.message(error)}` };
    }

    if (decision?.block) {
      return { index, tool, status: "blocked", text: decision.reason ?? `permissions: ${tool} blocked` };
    }

    try {
      const text = await this.execute(tool, input, ctx);

      return { index, tool, status: "ok", text };
    } catch (error) {
      return { index, tool, status: "error", text: BatchDispatcher.message(error) };
    }
  }

  private async execute(tool: string, input: Record<string, unknown>, ctx: ExtensionContext): Promise<string> {
    if (tool === "todo") {
      const handle = this.deps.resolveTodo();

      if (!handle) {
        throw new Error("todo tool is not available");
      }

      return BatchDispatcher.textOf(await handle.execute(input, ctx));
    }

    const def = this.deps.coreTools.build(tool as CoreToolName, ctx.cwd);
    const params = def.prepareArguments ? def.prepareArguments(input) : input;

    return BatchDispatcher.textOf(await def.execute(`batch-${tool}`, params, ctx.signal, undefined, ctx));
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private static textOf(outcome: ToolOutcome): string {
    const text = outcome.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();

    return text === "" ? "(no output)" : text;
  }
}
