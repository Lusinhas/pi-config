import { describe, expect, test } from "bun:test";
import { lineAnchor } from "../../../editing/src/lines/index.ts";
import { findAll, predictAfter } from "../../src/ide/preview.ts";

describe("predictAfter write", () => {
  test("returns content string", () => {
    expect(predictAfter("/x", "write", { content: "hello" }, null)).toBe("hello");
  });

  test("returns null when content not a string", () => {
    expect(predictAfter("/x", "write", { content: 5 }, null)).toBeNull();
  });
});

describe("predictAfter edit guards", () => {
  test("edit requires before content", () => {
    expect(predictAfter("/x", "edit", { oldText: "a", newText: "b" }, null)).toBeNull();
  });

  test("edit with both edits and oldText is rejected", () => {
    const input = { edits: [{ line: 1, op: "replace", text: "x" }], oldText: "a", newText: "b" };

    expect(predictAfter("/x", "edit", input, "a\n")).toBeNull();
  });

  test("edit with neither edits nor oldText is rejected", () => {
    expect(predictAfter("/x", "edit", {}, "a\n")).toBeNull();
  });

  test("unknown tool returns null", () => {
    expect(predictAfter("/x", "bash", { content: "x" }, "a")).toBeNull();
  });
});

describe("predictAfter line edits", () => {
  test("applies a replace by line", () => {
    const input = { edits: [{ line: 2, op: "replace", text: "TWO" }] };

    expect(predictAfter("/x", "edit", input, "one\ntwo\nthree\n")).toBe("one\nTWO\nthree\n");
  });

  test("rejects out-of-range line", () => {
    const input = { edits: [{ line: 99, op: "replace", text: "x" }] };

    expect(predictAfter("/x", "edit", input, "one\n")).toBeNull();
  });

  test("rejects duplicate replace on same line", () => {
    const input = {
      edits: [
        { line: 1, op: "replace", text: "a" },
        { line: 1, op: "replace", text: "b" },
      ],
    };

    expect(predictAfter("/x", "edit", input, "one\n")).toBeNull();
  });

  test("rejects non-string text on non-delete op", () => {
    const input = { edits: [{ line: 1, op: "replace", text: 5 }] };

    expect(predictAfter("/x", "edit", input, "one\n")).toBeNull();
  });

  test("rejects element that is not a LineEdit", () => {
    const input = { edits: [{ line: 1, op: "unknown", text: "x" }] };

    expect(predictAfter("/x", "edit", input, "one\n")).toBeNull();
  });

  test("delete and insertafter round-trip", () => {
    const before = "a\nb\nc\n";
    const deleted = predictAfter("/x", "edit", { edits: [{ line: 2, op: "delete" }] }, before);

    expect(deleted).toBe("a\nc\n");

    const inserted = predictAfter("/x", "edit", { edits: [{ line: 1, op: "insertafter", text: "X" }] }, "a\nb\n");

    expect(inserted).toBe("a\nX\nb\n");
  });
});

describe("predictAfter anchor resolution", () => {
  test("resolves a replace by unique anchor", () => {
    const before = "one\ntwo\nthree\n";
    const anchor = lineAnchor(2, "two");
    const input = { edits: [{ anchor, op: "replace", text: "TWO" }] };

    expect(predictAfter("/x", "edit", input, before)).toBe("one\nTWO\nthree\n");
  });

  test("anchor accepts a leading @ prefix", () => {
    const before = "alpha\nbeta\n";
    const anchor = `@${lineAnchor(1, "alpha")}`;
    const input = { edits: [{ anchor, op: "replace", text: "ALPHA" }] };

    expect(predictAfter("/x", "edit", input, before)).toBe("ALPHA\nbeta\n");
  });
});

describe("predictAfter compat replace", () => {
  test("single occurrence replace succeeds", () => {
    expect(predictAfter("/x", "edit", { oldText: "two", newText: "TWO" }, "one two three")).toBe("one TWO three");
  });

  test("multiple occurrences are rejected", () => {
    expect(predictAfter("/x", "edit", { oldText: "a", newText: "b" }, "a a a")).toBeNull();
  });

  test("empty oldText rejected", () => {
    expect(predictAfter("/x", "edit", { oldText: "", newText: "b" }, "abc")).toBeNull();
  });

  test("identical old and new rejected", () => {
    expect(predictAfter("/x", "edit", { oldText: "a", newText: "a" }, "abc")).toBeNull();
  });

  test("CRLF normalization retry restores dominant CRLF", () => {
    const before = "alpha\r\nbeta\r\ngamma\r\n";
    const result = predictAfter("/x", "edit", { oldText: "beta\n", newText: "BETA\n" }, before);

    expect(result).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });
});

describe("findAll", () => {
  test("non-overlapping positions", () => {
    expect(findAll("ababab", "ab")).toEqual([0, 2, 4]);
  });

  test("empty when not found", () => {
    expect(findAll("abc", "z")).toEqual([]);
  });
});
