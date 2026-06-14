import { describe, expect, test } from "bun:test";
import {
  OP_PRIORITY,
  SnapshotCache,
  StaleAnchorError,
  applyEdits,
  joinContent,
  lineAnchor,
  parseContent,
  renderNumberedLine,
  resolveSnapshotLine,
  splitText,
} from "../../src/lines/index.ts";
import type { ResolvedEdit } from "../../src/lines/index.ts";

describe("parseContent", () => {
  test("empty input yields empty parse with lf dominant", () => {
    expect(parseContent("")).toEqual({ lines: [], eols: [], dominantEol: "\n" });
  });

  test("lf only with trailing newline", () => {
    const parsed = parseContent("a\nb\n");
    expect(parsed.lines).toEqual(["a", "b"]);
    expect(parsed.eols).toEqual(["\n", "\n"]);
    expect(parsed.dominantEol).toBe("\n");
  });

  test("no trailing newline keeps last eol empty", () => {
    const parsed = parseContent("a\nb");
    expect(parsed.lines).toEqual(["a", "b"]);
    expect(parsed.eols).toEqual(["\n", ""]);
  });

  test("crlf dominant when more crlf than lf", () => {
    const parsed = parseContent("a\r\nb\r\nc\n");
    expect(parsed.lines).toEqual(["a", "b", "c"]);
    expect(parsed.eols).toEqual(["\r\n", "\r\n", "\n"]);
    expect(parsed.dominantEol).toBe("\r\n");
  });

  test("mixed eol with lf majority stays lf", () => {
    const parsed = parseContent("a\r\nb\nc\n");
    expect(parsed.dominantEol).toBe("\n");
  });

  test("round-trips through joinContent", () => {
    for (const content of ["a\nb\n", "a\nb", "a\r\nb\r\n", "x", "", "a\r\nb\nc"]) {
      const parsed = parseContent(content);
      expect(joinContent(parsed.lines, parsed.eols)).toBe(content);
    }
  });
});

describe("joinContent", () => {
  test("missing eol entry defaults to lf", () => {
    expect(joinContent(["a", "b"], ["\n"])).toBe("a\nb\n");
  });
});

describe("renderNumberedLine", () => {
  test("short line renders with hash anchor prefix", () => {
    expect(renderNumberedLine(7, "hello", 2000)).toMatch(/^@[A-Za-z0-9_-]{7} 7: hello$/);
  });

  test("line exactly at max is not truncated", () => {
    const text = "x".repeat(10);
    expect(renderNumberedLine(1, text, 10)).toMatch(/^@[A-Za-z0-9_-]{7} 1: x{10}$/);
  });

  test("line one over max is truncated with suffix", () => {
    const text = "x".repeat(11);
    const rendered = renderNumberedLine(1, text, 10);
    expect(rendered).toMatch(/^@[A-Za-z0-9_-]{7} 1: /);
    expect(rendered.endsWith(`${"x".repeat(10)} [line truncated: 1 more chars]`)).toBe(true);
  });
});

describe("lineAnchor", () => {
  test("returns a stable 7-char base64url string", () => {
    const anchor = lineAnchor(3, "const value = 1");
    expect(anchor).toMatch(/^[A-Za-z0-9_-]{7}$/);
    expect(lineAnchor(3, "const value = 1")).toBe(anchor);
  });

  test("same content uses content seed so line number does not matter", () => {
    expect(lineAnchor(5, "  hello world")).toBe(lineAnchor(42, "  hello world"));
  });

  test("trailing whitespace and carriage returns are normalized away", () => {
    expect(lineAnchor(1, "value")).toBe(lineAnchor(1, "value  \r"));
  });

  test("structural-only line is line-scoped so different lines differ", () => {
    expect(lineAnchor(2, "}")).not.toBe(lineAnchor(9, "}"));
    expect(lineAnchor(2, "}")).toBe(lineAnchor(2, "}"));
  });
});

describe("splitText", () => {
  test("strips a single trailing crlf", () => {
    expect(splitText("a\r\n")).toEqual(["a"]);
  });

  test("strips a single trailing lf", () => {
    expect(splitText("a\n")).toEqual(["a"]);
  });

  test("splits interior newlines", () => {
    expect(splitText("a\nb\r\nc")).toEqual(["a", "b", "c"]);
  });

  test("keeps a final blank line when two trailing newlines", () => {
    expect(splitText("a\n\n")).toEqual(["a", ""]);
  });
});

describe("OP_PRIORITY", () => {
  test("insertafter first, insertbefore last", () => {
    expect(OP_PRIORITY).toEqual({ insertafter: 0, replace: 1, delete: 1, insertbefore: 2 });
  });
});

describe("SnapshotCache", () => {
  test("merge accumulates and lookup returns line text", () => {
    const cache = new SnapshotCache();
    cache.merge("p", new Map([[1, "a"]]));
    cache.merge("p", new Map([[2, "b"]]));
    expect(cache.lookup("p", 1)).toBe("a");
    expect(cache.lookup("p", 2)).toBe("b");
    expect(cache.has("p")).toBe(true);
  });

  test("replaceAll resets to 1-based numbering", () => {
    const cache = new SnapshotCache();
    cache.merge("p", new Map([[5, "old"]]));
    cache.replaceAll("p", ["x", "y"]);
    expect(cache.lookup("p", 1)).toBe("x");
    expect(cache.lookup("p", 2)).toBe("y");
    expect(cache.lookup("p", 5)).toBeUndefined();
  });

  test("replaceAll with empty list keeps path present", () => {
    const cache = new SnapshotCache();
    cache.replaceAll("p", []);
    expect(cache.has("p")).toBe(true);
    expect(cache.lookup("p", 1)).toBeUndefined();
  });

  test("clear drops everything", () => {
    const cache = new SnapshotCache();
    cache.replaceAll("p", ["x"]);
    cache.clear();
    expect(cache.has("p")).toBe(false);
  });

  test("entries exposes the cached line map and clear drops anchors", () => {
    const cache = new SnapshotCache();
    cache.replaceAll("p", ["alpha", "beta"]);
    const entries = cache.entries("p");
    expect(entries?.get(1)).toBe("alpha");
    expect(entries?.get(2)).toBe("beta");
    cache.clear();
    expect(cache.entries("p")).toBeUndefined();
  });

  test("lookupAnchor returns cached lines for a content anchor", () => {
    const cache = new SnapshotCache();
    cache.replaceAll("p", ["alpha", "beta"]);
    const anchor = lineAnchor(1, "alpha");
    const matches = cache.lookupAnchor("p", anchor);
    expect(matches.length).toBe(1);
    expect(matches[0]).toEqual({ lineNumber: 1, text: "alpha", anchor });
    expect(cache.lookupAnchor("p", "missing")).toEqual([]);
  });

  test("duplicate content lines share an anchor bucket", () => {
    const cache = new SnapshotCache();
    cache.replaceAll("p", ["same", "same"]);
    const anchor = lineAnchor(1, "same");
    const matches = cache.lookupAnchor("p", anchor);
    expect(matches.map((m) => m.lineNumber)).toEqual([1, 2]);
  });
});

describe("resolveSnapshotLine", () => {
  test("exact match returns same line and shifted false", () => {
    const lines = ["a", "b", "c"];
    const cached = new Map([[1, "a"], [2, "b"], [3, "c"]]);
    const result = resolveSnapshotLine(lines, 2, "b", cached);
    expect(result.lineNumber).toBe(2);
    expect(result.shifted).toBe(false);
    expect(result.ambiguous).toBe(false);
  });

  test("shifted line found via context returns new line and shifted true", () => {
    const lines = ["header", "a", "b", "c"];
    const cached = new Map([[1, "a"], [2, "b"], [3, "c"]]);
    const result = resolveSnapshotLine(lines, 2, "b", cached);
    expect(result.lineNumber).toBe(3);
    expect(result.shifted).toBe(true);
    expect(result.ambiguous).toBe(false);
  });

  test("recorded line that still holds the snapshot is honored over a duplicate elsewhere", () => {
    const lines = ["dup", "x", "dup"];
    const cached = new Map([[1, "dup"]]);
    const result = resolveSnapshotLine(lines, 1, "dup", cached);
    expect(result.lineNumber).toBe(1);
    expect(result.shifted).toBe(false);
    expect(result.ambiguous).toBe(false);
  });

  test("does not relocate to a duplicate when nearby context shifted but the line is intact", () => {
    const lines = ["x", "changed", "target", "y", "target"];
    const cached = new Map([[1, "a"], [2, "b"], [3, "target"], [4, "y"], [5, "target"]]);
    const result = resolveSnapshotLine(lines, 3, "target", cached);
    expect(result.lineNumber).toBe(3);
    expect(result.shifted).toBe(false);
  });

  test("ambiguous when the recorded line moved and the content now matches multiple places", () => {
    const lines = ["x", "dup", "y", "dup"];
    const cached = new Map([[1, "dup"]]);
    const result = resolveSnapshotLine(lines, 1, "dup", cached);
    expect(result.lineNumber).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toEqual([2, 4]);
  });

  test("missing snapshot returns null line and not ambiguous", () => {
    const lines = ["a", "b", "c"];
    const cached = new Map([[1, "a"]]);
    const result = resolveSnapshotLine(lines, 1, "gone", cached);
    expect(result.lineNumber).toBeNull();
    expect(result.ambiguous).toBe(false);
    expect(result.candidates).toEqual([]);
  });
});

describe("StaleAnchorError", () => {
  test("carries name StaleAnchorError", () => {
    const error = new StaleAnchorError("boom");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StaleAnchorError");
    expect(error.message).toBe("boom");
  });
});

function resolve(line: number, op: ResolvedEdit["edit"]["op"], text?: string): ResolvedEdit {
  return { edit: { line, op, text }, lineNumber: line };
}

describe("applyEdits", () => {
  test("throws on empty resolved list", () => {
    expect(() => applyEdits(parseContent("a\n"), [])).toThrow("no edits to apply");
  });

  test("replace single line keeps trailing eol", () => {
    const parsed = parseContent("a\nb\nc\n");
    const outcome = applyEdits(parsed, [resolve(2, "replace", "B")]);
    expect(joinContent(outcome.lines, outcome.eols)).toBe("a\nB\nc\n");
    expect(outcome.counts).toEqual({ replace: 1, insert: 0, delete: 0 });
    expect(outcome.netDelta).toBe(0);
  });

  test("multi-line replace adds netDelta and uses dominant eol for interior", () => {
    const parsed = parseContent("a\nb\nc\n");
    const outcome = applyEdits(parsed, [resolve(2, "replace", "X\nY\nZ")]);
    expect(joinContent(outcome.lines, outcome.eols)).toBe("a\nX\nY\nZ\nc\n");
    expect(outcome.netDelta).toBe(2);
  });

  test("delete removes the line and netDelta -1", () => {
    const parsed = parseContent("a\nb\nc\n");
    const outcome = applyEdits(parsed, [resolve(2, "delete")]);
    expect(joinContent(outcome.lines, outcome.eols)).toBe("a\nc\n");
    expect(outcome.counts.delete).toBe(1);
    expect(outcome.netDelta).toBe(-1);
  });

  test("insertafter places text after the target", () => {
    const parsed = parseContent("a\nb\n");
    const outcome = applyEdits(parsed, [resolve(1, "insertafter", "mid")]);
    expect(joinContent(outcome.lines, outcome.eols)).toBe("a\nmid\nb\n");
    expect(outcome.netDelta).toBe(1);
  });

  test("insertbefore places text before the target", () => {
    const parsed = parseContent("a\nb\n");
    const outcome = applyEdits(parsed, [resolve(2, "insertbefore", "mid")]);
    expect(joinContent(outcome.lines, outcome.eols)).toBe("a\nmid\nb\n");
  });

  test("multiple inserts on one line both apply via op priority ordering", () => {
    const parsed = parseContent("a\nb\n");
    const outcome = applyEdits(parsed, [resolve(1, "insertafter", "A"), resolve(1, "insertbefore", "B")]);
    expect(joinContent(outcome.lines, outcome.eols)).toBe("B\na\nA\nb\n");
    expect(outcome.counts.insert).toBe(2);
  });

  test("mixed ops on adjacent lines apply descending", () => {
    const parsed = parseContent("a\nb\nc\n");
    const outcome = applyEdits(parsed, [resolve(1, "replace", "A"), resolve(3, "delete")]);
    expect(joinContent(outcome.lines, outcome.eols)).toBe("A\nb\n");
  });

  test("no trailing newline preserved after replace on last line", () => {
    const parsed = parseContent("a\nb");
    const outcome = applyEdits(parsed, [resolve(2, "replace", "B")]);
    expect(joinContent(outcome.lines, outcome.eols)).toBe("a\nB");
  });

  test("insert into file without trailing newline restores no-newline tail", () => {
    const parsed = parseContent("a\nb");
    const outcome = applyEdits(parsed, [resolve(1, "insertafter", "mid")]);
    expect(joinContent(outcome.lines, outcome.eols)).toBe("a\nmid\nb");
  });

  test("crlf dominant file keeps crlf on inserted interior lines", () => {
    const parsed = parseContent("a\r\nb\r\n");
    const outcome = applyEdits(parsed, [resolve(1, "insertafter", "x\ny")]);
    expect(joinContent(outcome.lines, outcome.eols)).toBe("a\r\nx\r\ny\r\nb\r\n");
  });

  test("region reflects mutated bounds", () => {
    const parsed = parseContent("a\nb\nc\nd\n");
    const outcome = applyEdits(parsed, [resolve(2, "insertafter", "x\ny")]);
    expect(outcome.regionStart).toBe(2);
    expect(outcome.regionEnd).toBeGreaterThanOrEqual(2);
  });

  test("deleting all lines yields empty region start", () => {
    const parsed = parseContent("a\n");
    const outcome = applyEdits(parsed, [resolve(1, "delete")]);
    expect(outcome.lines).toEqual([]);
    expect(outcome.regionStart).toBe(0);
  });
});
