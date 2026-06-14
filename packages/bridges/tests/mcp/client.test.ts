import { describe, expect, test } from "bun:test";
import {
  base64Size,
  formatBytes,
  renderContentBlocks,
  renderPromptMessages,
  type McpContentBlock,
} from "../../src/mcp/client.ts";

describe("base64Size", () => {
  test("non-strings and empty are zero", () => {
    expect(base64Size(null)).toBe(0);
    expect(base64Size("")).toBe(0);
    expect(base64Size(5)).toBe(0);
  });

  test("accounts for padding", () => {
    expect(base64Size("AAAA")).toBe(3);
    expect(base64Size("AAA=")).toBe(2);
    expect(base64Size("AA==")).toBe(1);
  });
});

describe("formatBytes", () => {
  test("bytes, kilobytes, megabytes", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(1048576 * 3)).toBe("3.0MB");
  });
});

describe("renderContentBlocks", () => {
  test("text blocks skip empties and join with blank line", () => {
    const blocks: McpContentBlock[] = [
      { type: "text", text: "one" },
      { type: "text", text: "" },
      { type: "text", text: "two" },
    ];

    expect(renderContentBlocks(blocks, 8192)).toBe("one\n\ntwo");
  });

  test("image and audio fall back to unknown type", () => {
    expect(renderContentBlocks([{ type: "image", data: "AAAA" }], 8192)).toBe("[image unknown type, 3B]");
    expect(renderContentBlocks([{ type: "audio", mimeType: "audio/wav", data: "AAAA" }], 8192)).toBe(
      "[audio audio/wav, 3B]",
    );
  });

  test("inline resource text within limit", () => {
    const block: McpContentBlock = { type: "resource", resource: { uri: "file://x", text: "hello" } };

    expect(renderContentBlocks([block], 8192)).toBe("[resource file://x]\nhello");
  });

  test("resource text over limit reports size only", () => {
    const block: McpContentBlock = { type: "resource", resource: { uri: "file://x", text: "abcdef" } };

    expect(renderContentBlocks([block], 3)).toBe("[resource file://x: 6B of text, too large to inline]");
  });

  test("resource blob reports mime and size", () => {
    const block: McpContentBlock = { type: "resource", resource: { uri: "u", blob: "AAAA", mimeType: "image/png" } };

    expect(renderContentBlocks([block], 8192)).toBe("[resource u: image/png, 3B]");
  });

  test("bare resource without text or blob", () => {
    expect(renderContentBlocks([{ type: "resource", resource: {} }], 8192)).toBe("[resource unknown uri]");
  });

  test("resource link with and without name", () => {
    expect(renderContentBlocks([{ type: "resource_link", uri: "u", name: "n" }], 8192)).toBe("[resource link u (n)]");
    expect(renderContentBlocks([{ type: "resource_link", uri: "u" }], 8192)).toBe("[resource link u]");
  });

  test("unknown content types reported", () => {
    expect(renderContentBlocks([{ type: "weird" }], 8192)).toBe('[unsupported content type "weird"]');
  });
});

describe("renderPromptMessages", () => {
  test("single message has no role prefix", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

    expect(renderPromptMessages(messages, 8192)).toBe("hi");
  });

  test("multiple messages prefix the role", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "ask" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ];

    expect(renderPromptMessages(messages, 8192)).toBe("[user]\nask\n\n[assistant]\nanswer");
  });

  test("empty-rendered messages are skipped and result trimmed", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "" }] },
      { role: "assistant", content: [{ type: "text", text: "x" }] },
    ];

    expect(renderPromptMessages(messages, 8192)).toBe("[assistant]\nx");
  });
});
