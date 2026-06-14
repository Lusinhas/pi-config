import { Buffer } from "node:buffer";
import { describe, expect, test } from "bun:test";
import { Messages } from "../../src/compaction/index.ts";

const messages = new Messages();

describe("guards", () => {
  test("isToolResult requires the full shape", () => {
    expect(messages.isToolResult({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [] })).toBe(true);
    expect(messages.isToolResult({ role: "toolResult", toolCallId: "c1", toolName: "read" })).toBe(false);
    expect(messages.isToolResult({ role: "user", content: [] })).toBe(false);
    expect(messages.isToolResult(null)).toBe(false);
  });

  test("messageOf only unwraps message-type entries", () => {
    expect(messageOfRole({ type: "message", message: { role: "user" } })).toBe("user");
    expect(messages.messageOf({ type: "compaction" })).toBeUndefined();
    expect(messages.messageOf({ type: "message", message: 7 })).toBeUndefined();
  });
});

function messageOfRole(entry: unknown): unknown {
  const m = messages.messageOf(entry);

  return m ? m.role : undefined;
}

describe("contentBytes", () => {
  test("string content uses utf8 byte length", () => {
    expect(messages.contentBytes("héllo")).toBe(Buffer.byteLength("héllo", "utf8"));
  });

  test("text blocks summed, image data counted by length, other blocks via token estimate", () => {
    const content = [
      { type: "text", text: "abcd" },
      { type: "image", data: "0123456789" },
      { type: "thinking", value: "x".repeat(8) },
    ];
    const other = Math.ceil(JSON.stringify({ type: "thinking", value: "x".repeat(8) }).length / 4) * 4;

    expect(messages.contentBytes(content)).toBe(4 + 10 + other);
  });

  test("non-array, non-string content is zero", () => {
    expect(messages.contentBytes(42)).toBe(0);
  });
});

describe("estimateTokens", () => {
  test("string by length over four", () => {
    expect(messages.estimateTokens("abcdef")).toBe(2);
  });

  test("object via serialized length", () => {
    expect(messages.estimateTokens({ a: 1 })).toBe(Math.ceil(JSON.stringify({ a: 1 }).length / 4));
  });

  test("circular value yields zero", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(messages.estimateTokens(circular)).toBe(0);
  });
});

describe("textOfContent", () => {
  test("string passes through", () => {
    expect(messages.textOfContent("plain")).toBe("plain");
  });

  test("joins text blocks and marks images", () => {
    expect(messages.textOfContent([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe(
      "a\n[image]\nb",
    );
  });
});

describe("safeStringify", () => {
  test("returns serialized string", () => {
    expect(messages.safeStringify({ a: 1 })).toBe('{"a":1}');
  });

  test("undefined input returns undefined", () => {
    expect(messages.safeStringify(undefined)).toBeUndefined();
  });

  test("circular returns undefined", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(messages.safeStringify(circular)).toBeUndefined();
  });
});

describe("formatSize", () => {
  test("bytes under 1KiB", () => {
    expect(messages.formatSize(0)).toBe("0B");
    expect(messages.formatSize(1023)).toBe("1023B");
  });

  test("kibibytes with one decimal", () => {
    expect(messages.formatSize(1024)).toBe("1.0KB");
    expect(messages.formatSize(1536)).toBe("1.5KB");
  });

  test("mebibytes with one decimal", () => {
    expect(messages.formatSize(1024 * 1024)).toBe("1.0MB");
    expect(messages.formatSize(1024 * 1024 * 3 + 512 * 1024)).toBe("3.5MB");
  });
});
