import { describe, expect, test } from "bun:test";
import { TailTruncator } from "../../src/mcp/cache.ts";

const truncator = new TailTruncator();

describe("TailTruncator", () => {
  test("returns content unchanged when within limits", () => {
    const result = truncator.truncate("hello", { maxBytes: 100, maxLines: 100 });

    expect(result.content).toBe("hello");
    expect(result.truncated).toBeUndefined();
    expect(result.totalBytes).toBe(5);
    expect(result.totalLines).toBe(1);
  });

  test("keeps the tail when bytes exceed the limit", () => {
    const result = truncator.truncate("0123456789", { maxBytes: 4, maxLines: 1000 });

    expect(result.truncated).toBe(true);
    expect(result.content).toBe("6789");
    expect(result.totalBytes).toBe(10);
  });

  test("keeps the last whole lines under a line cap", () => {
    const result = truncator.truncate("a\nb\nc\nd", { maxBytes: 1000, maxLines: 2 });

    expect(result.truncated).toBe(true);
    expect(result.content).toBe("c\nd");
    expect(result.totalLines).toBe(4);
  });

  test("byte cap can drop earlier lines", () => {
    const result = truncator.truncate("aaaa\nbbbb\ncccc", { maxBytes: 9, maxLines: 1000 });

    expect(result.truncated).toBe(true);
    expect(result.content).toBe("bbbb\ncccc");
  });

  test("respects utf-8 boundaries when slicing", () => {
    const result = truncator.truncate("héllo", { maxBytes: 3, maxLines: 1000 });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(3);
    expect(result.content.includes("�")).toBe(false);
  });
});
