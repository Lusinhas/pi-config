import { describe, expect, test } from "bun:test";
import { BillingHeader } from "../../src/signing/billing.ts";
import { ModelCatalog } from "../../src/models/catalog.ts";
import { ClaudeCodeTransform, SYSTEM_IDENTITY } from "../../src/transforms/reshape.ts";

function transform(): ClaudeCodeTransform {
  return new ClaudeCodeTransform(new ModelCatalog(), new BillingHeader());
}

type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  input?: Record<string, unknown>;
};

type Message = { role: "user" | "assistant"; content: ContentBlock[] };

describe("ClaudeCodeTransform", () => {
  test("injects identity and billing header into system", () => {
    const params = {
      system: "project instructions",
      tools: [{ name: "search" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] satisfies Message[],
    };

    const result = transform().apply(params);

    expect(result).toBe(params);

    const system = params.system as Array<{ text?: string }>;

    expect(system[0]?.text).toMatch(/^x-anthropic-billing-header:/);
    expect(system.some((e) => e.text === SYSTEM_IDENTITY)).toBe(true);
  });

  test("moves third-party system text into first user message", () => {
    const params = {
      system: "project instructions",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] satisfies Message[],
    };

    transform().apply(params);

    expect(params.messages[0]?.content[0]).toEqual({ type: "text", text: "project instructions" });
  });

  test("prefixes tool names with mcp_<Pascal>", () => {
    const params = { tools: [{ name: "search" }] };
    const t = transform();

    t.apply(params);

    expect(params.tools[0]?.name).toBe("mcp_Search");
    expect(t.unprefixToolName(params.tools[0]?.name ?? "")).toBe("search");
  });

  test("removes orphan tool_use and substitutes a placeholder", () => {
    const params = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "search", input: {} }] },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ] satisfies Message[],
    };

    transform().apply(params);

    expect(params.messages).toHaveLength(3);
    expect(params.messages[1]?.content).toEqual([{ type: "text", text: "(no content)" }]);
  });

  test("strips effort from thinking for haiku", () => {
    const params = {
      model: "claude-haiku-4-5",
      thinking: { type: "enabled", effort: "high" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] satisfies Message[],
    };

    transform().apply(params);

    expect(params.thinking).toEqual({ type: "enabled" });
  });

  test("matched tool pair survives with only the tool name prefixed", () => {
    const params = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "search", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", text: "ok" }] },
      ] satisfies Message[],
    };

    transform().apply(params);

    expect(params.messages[0]?.content).toEqual([
      { type: "tool_use", id: "tool-1", name: "mcp_Search", input: {} },
    ]);
    expect(params.messages[1]?.content).toEqual([
      { type: "tool_result", tool_use_id: "tool-1", text: "ok" },
    ]);
  });
});
