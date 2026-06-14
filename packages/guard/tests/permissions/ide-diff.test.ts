import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PermissionsRegistrar } from "../../src/extension/permissions.ts";
import { Loader, type PermissionsConfig } from "../../src/permissions/loader.ts";
import type { DecisionResult } from "../../src/permissions/state.ts";

const IDE_KEY = Symbol.for("piconfig.ide");

interface DiffOutcome {
  decision: "accept" | "reject";
  content: string;
  edited: boolean;
  beforeText: string;
}

function config(overrides: Partial<PermissionsConfig> = {}): PermissionsConfig {
  return { ...Loader.FALLBACK, ...overrides };
}

function host(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>;
}

function publishIde(outcome: DiffOutcome | undefined): void {
  host()[IDE_KEY] = {
    isConnected: async () => true,
    requestDiffApproval: async () => outcome,
  };
}

function publishPendingIde(): void {
  host()[IDE_KEY] = {
    isConnected: async () => true,
    requestDiffApproval: () => new Promise<DiffOutcome | undefined>(() => undefined),
  };
}

function clearIde(): void {
  delete host()[IDE_KEY];
}

function fakeApi(): ExtensionAPI {
  return {
    on: () => undefined,
    registerCommand: () => undefined,
    appendEntry: () => undefined,
    events: { emit: () => undefined },
  } as unknown as ExtensionAPI;
}

function fakeCtx(promptResult: string | undefined): ExtensionContext {
  return {
    hasUI: true,
    cwd: "/repo",
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
      select: async () => promptResult,
    },
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
}

function pendingCtx(): ExtensionContext {
  return {
    hasUI: true,
    cwd: "/repo",
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
      select: () => new Promise<string | undefined>(() => undefined),
    },
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
}

function decide(
  registrar: PermissionsRegistrar,
  ctx: ExtensionContext,
  input: unknown,
  toolName = "write",
): Promise<DecisionResult> {
  return (registrar as unknown as {
    onToolCall(event: { toolName: string; input: unknown }, ctx: ExtensionContext): Promise<DecisionResult>;
  }).onToolCall({ toolName, input }, ctx);
}

afterEach(() => {
  clearIde();
});

describe("ideDiff approval routing", () => {
  test("reject decision blocks the write", async () => {
    publishIde({ decision: "reject", content: "", edited: false, beforeText: "" });

    const registrar = new PermissionsRegistrar(fakeApi(), config({ mode: "ask", ideDiff: true }));
    const input = { file_path: "/repo/a.ts", content: "original" };

    const result = await decide(registrar, pendingCtx(), input);

    expect(result).toEqual({ block: true, reason: "permissions: write rejected in the IDE diff" });
  });

  test("accept with hand edits allows and patches the input content", async () => {
    publishIde({ decision: "accept", content: "edited by user", edited: true, beforeText: "original" });

    const registrar = new PermissionsRegistrar(fakeApi(), config({ mode: "ask", ideDiff: true }));
    const input = { file_path: "/repo/a.ts", content: "original" };

    const result = await decide(registrar, pendingCtx(), input);

    expect(result).toBeUndefined();
    expect(input.content).toBe("edited by user");
  });

  test("accept without edits allows and leaves the input untouched", async () => {
    publishIde({ decision: "accept", content: "ignored", edited: false, beforeText: "original" });

    const registrar = new PermissionsRegistrar(fakeApi(), config({ mode: "ask", ideDiff: true }));
    const input = { file_path: "/repo/a.ts", content: "original" };

    const result = await decide(registrar, pendingCtx(), input);

    expect(result).toBeUndefined();
    expect(input.content).toBe("original");
  });

  test("edit with hand edits writes the whole file via content and allows", async () => {
    publishIde({ decision: "accept", content: "after", edited: true, beforeText: "before" });

    const registrar = new PermissionsRegistrar(fakeApi(), config({ mode: "ask", ideDiff: true }));
    const input: Record<string, unknown> = { file_path: "/repo/a.ts", edits: [{ a: 1 }] };

    const result = await decide(registrar, pendingCtx(), input, "edit");

    expect(result).toBeUndefined();
    expect(input.content).toBe("after");
    expect(input.edits).toBeUndefined();
    expect(input.oldText).toBeUndefined();
  });

  test("no IDE handle falls back to the normal prompt", async () => {
    clearIde();

    const registrar = new PermissionsRegistrar(fakeApi(), config({ mode: "ask", ideDiff: true }));
    const input = { file_path: "/repo/a.ts", content: "original" };

    const result = await decide(registrar, fakeCtx("deny"), input);

    expect(result).toEqual({ block: true, reason: "permissions: write denied by user" });
  });

  test("terminal deny wins while the IDE diff is still pending", async () => {
    publishPendingIde();

    const registrar = new PermissionsRegistrar(fakeApi(), config({ mode: "ask", ideDiff: true }));
    const input = { file_path: "/repo/a.ts", content: "original" };

    const result = await decide(registrar, fakeCtx("deny"), input);

    expect(result).toEqual({ block: true, reason: "permissions: write denied by user" });
  });

  test("terminal allow once wins while the IDE diff is still pending", async () => {
    publishPendingIde();

    const registrar = new PermissionsRegistrar(fakeApi(), config({ mode: "ask", ideDiff: true }));
    const input = { file_path: "/repo/a.ts", content: "original" };

    const result = await decide(registrar, fakeCtx("allow once"), input);

    expect(result).toBeUndefined();
    expect(input.content).toBe("original");
  });
});

describe("PermissionsRegistrar.patchToolInput", () => {
  function patcher(): (toolName: string, input: unknown, content: string) => boolean {
    const registrar = new PermissionsRegistrar(fakeApi(), config({ ideDiff: true }));

    return (registrar as unknown as {
      patchToolInput(toolName: string, input: unknown, content: string): boolean;
    }).patchToolInput.bind(registrar);
  }

  test("write sets content", () => {
    const input: Record<string, unknown> = { content: "old" };

    expect(patcher()("write", input, "new write")).toBe(true);
    expect(input.content).toBe("new write");
  });

  test("edit writes whole-file content and drops edit fields", () => {
    const input: Record<string, unknown> = { edits: [{ a: 1 }], oldText: "x", newText: "y" };

    expect(patcher()("edit", input, "whole new file")).toBe(true);
    expect(input.content).toBe("whole new file");
    expect(input.edits).toBeUndefined();
    expect(input.oldText).toBeUndefined();
    expect(input.newText).toBeUndefined();
  });

  test("non-record input returns false", () => {
    expect(patcher()("write", "not-a-record", "content")).toBe(false);
  });
});
