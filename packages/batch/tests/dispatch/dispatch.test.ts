import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BatchDispatcher,
  type BatchCall,
  type CoreToolProvider,
  type ExecutableTool,
  type PermissionBroker,
  type PermissionDecision,
  type TodoHandle,
  type ToolOutcome,
} from "../../src/dispatch/dispatch.ts";

function ctx(): ExtensionContext {
  return { cwd: "/repo", signal: undefined } as unknown as ExtensionContext;
}

function textOutcome(text: string): ToolOutcome {
  return { content: [{ type: "text", text }] };
}

function recordingTool(log: string[], output: string): ExecutableTool {
  return {
    execute: async (toolCallId, params): Promise<ToolOutcome> => {
      log.push(`${toolCallId}:${JSON.stringify(params)}`);

      return textOutcome(output);
    },
  };
}

interface Deps {
  broker?: PermissionBroker;
  todo?: TodoHandle;
  core?: CoreToolProvider;
  allowed?: string[];
}

function dispatcher(deps: Deps): BatchDispatcher {
  const fallbackCore: CoreToolProvider = { build: () => recordingTool([], "core output") };

  return new BatchDispatcher({
    resolveBroker: () => deps.broker,
    resolveTodo: () => deps.todo,
    coreTools: deps.core ?? fallbackCore,
    allowed: new Set<string>(deps.allowed ?? ["read", "write", "edit", "grep", "find", "ls", "bash", "todo"]),
  });
}

function allowBroker(): PermissionBroker {
  return { decide: async () => undefined };
}

const calls = (list: BatchCall[]): BatchCall[] => list;

describe("BatchDispatcher", () => {
  test("runs allowed core calls in order and aggregates results", async () => {
    const log: string[] = [];
    const core: CoreToolProvider = { build: (name) => recordingTool(log, `ran ${name}`) };

    const outcome = await dispatcher({ broker: allowBroker(), core }).run(
      calls([
        { tool: "read", input: { path: "a.ts" } },
        { tool: "grep", input: { pattern: "x" } },
      ]),
      ctx(),
    );

    expect(outcome.results.map((r) => [r.index, r.tool, r.status, r.text])).toEqual([
      [0, "read", "ok", "ran read"],
      [1, "grep", "ok", "ran grep"],
    ]);
    expect(log).toEqual([`batch-read:{"path":"a.ts"}`, `batch-grep:{"pattern":"x"}`]);
  });

  test("blocks a sub-call when the broker denies it but continues the rest", async () => {
    const decisions: PermissionDecision[] = [{ block: true, reason: "permissions: write denied by user" }];
    const broker: PermissionBroker = {
      decide: async (tool) => (tool === "write" ? decisions[0] : undefined),
    };
    const core: CoreToolProvider = { build: (name) => recordingTool([], `ran ${name}`) };

    const outcome = await dispatcher({ broker, core }).run(
      calls([
        { tool: "write", input: { path: "a.ts", content: "x" } },
        { tool: "read", input: { path: "a.ts" } },
      ]),
      ctx(),
    );

    expect(outcome.results[0]).toEqual({ index: 0, tool: "write", status: "blocked", text: "permissions: write denied by user" });
    expect(outcome.results[1].status).toBe("ok");
  });

  test("rejects tools outside the allowlist", async () => {
    const outcome = await dispatcher({ broker: allowBroker(), allowed: ["read"] }).run(
      calls([{ tool: "bash", input: { command: "ls" } }]),
      ctx(),
    );

    expect(outcome.results[0].status).toBe("error");
    expect(outcome.results[0].text).toContain("not available for batching");
  });

  test("errors when no permissions broker is available", async () => {
    const outcome = await dispatcher({}).run(calls([{ tool: "read", input: {} }]), ctx());

    expect(outcome.results[0].status).toBe("error");
    expect(outcome.results[0].text).toContain("permissions broker unavailable");
  });

  test("routes todo through the published handle", async () => {
    const seen: Record<string, unknown>[] = [];
    const todo: TodoHandle = {
      execute: async (params): Promise<ToolOutcome> => {
        seen.push(params);

        return textOutcome("todo added");
      },
    };

    const outcome = await dispatcher({ broker: allowBroker(), todo }).run(
      calls([{ tool: "todo", input: { op: "add", text: "ship it" } }]),
      ctx(),
    );

    expect(outcome.results[0]).toEqual({ index: 0, tool: "todo", status: "ok", text: "todo added" });
    expect(seen).toEqual([{ op: "add", text: "ship it" }]);
  });

  test("reports an error when todo is requested but unavailable", async () => {
    const outcome = await dispatcher({ broker: allowBroker() }).run(calls([{ tool: "todo", input: {} }]), ctx());

    expect(outcome.results[0].status).toBe("error");
    expect(outcome.results[0].text).toContain("todo tool is not available");
  });

  test("captures tool execution errors per call", async () => {
    const core: CoreToolProvider = {
      build: () => ({
        execute: async (): Promise<ToolOutcome> => {
          throw new Error("disk full");
        },
      }),
    };

    const outcome = await dispatcher({ broker: allowBroker(), core }).run(calls([{ tool: "write", input: {} }]), ctx());

    expect(outcome.results[0]).toEqual({ index: 0, tool: "write", status: "error", text: "disk full" });
  });

  test("applies prepareArguments before executing", async () => {
    const seen: unknown[] = [];
    const core: CoreToolProvider = {
      build: () => ({
        prepareArguments: (args) => ({ ...(args as Record<string, unknown>), normalized: true }),
        execute: async (_id, params): Promise<ToolOutcome> => {
          seen.push(params);

          return textOutcome("done");
        },
      }),
    };

    await dispatcher({ broker: allowBroker(), core }).run(calls([{ tool: "edit", input: { path: "a.ts" } }]), ctx());

    expect(seen).toEqual([{ path: "a.ts", normalized: true }]);
  });
});
