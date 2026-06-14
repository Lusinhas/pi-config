import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { Text, type RenderOptions } from "../../src/view/text.ts";
import { Previews } from "../../src/view/previews.ts";
import { Renderer } from "../../src/view/index.ts";

const cwd = "/work/project";

function opts(over: Partial<RenderOptions> = {}): RenderOptions {
  return { maxLines: 12, maxLineChars: 160, cwd, ...over };
}

const renderer = new Renderer();
const previews = new Previews();

const NUL = String.fromCharCode(0x00);
const BS = String.fromCharCode(0x08);
const TAB = String.fromCharCode(0x09);
const VT = String.fromCharCode(0x0b);
const US = String.fromCharCode(0x1f);

describe("Text.splitLines", () => {
  test("normalizes crlf and splits on lf", () => {
    expect(Text.splitLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });

  test("keeps interior and trailing blanks", () => {
    expect(Text.splitLines("a\n\nb\n")).toEqual(["a", "", "b", ""]);
  });
});

describe("Text.safeStringify", () => {
  test("stringifies plain values", () => {
    expect(Text.safeStringify({ a: 1 })).toBe('{"a":1}');
    expect(Text.safeStringify(42)).toBe("42");
  });

  test("falls back to String when JSON returns undefined", () => {
    expect(Text.safeStringify(undefined)).toBe("undefined");
  });

  test("falls back to String on circular structures", () => {
    const a: Record<string, unknown> = {};
    a.self = a;

    expect(Text.safeStringify(a)).toBe("[object Object]");
  });
});

describe("Text.clip", () => {
  test("replaces carriage return with a space", () => {
    expect(Text.clip("a\rb", 160)).toBe("a b");
  });

  test("strips control bytes in the 0x00-0x08 range", () => {
    expect(Text.clip(`a${NUL}b${BS}c`, 160)).toBe("a b c");
  });

  test("strips control bytes in the 0x0b-0x1f range", () => {
    expect(Text.clip(`a${VT}b${US}c`, 160)).toBe("a b c");
  });

  test("preserves tab (0x09) and newline (0x0a)", () => {
    expect(Text.clip(`a${TAB}b`, 160)).toBe(`a${TAB}b`);
    expect(Text.clip("a\nb", 160)).toBe("a\nb");
  });

  test("returns sanitized unchanged when within max", () => {
    expect(Text.clip("hello", 5)).toBe("hello");
  });

  test("truncates with ellipsis using max-1 slice when over", () => {
    expect(Text.clip("hello", 4)).toBe("hel…");
  });

  test("uses at least one character before ellipsis", () => {
    expect(Text.clip("hello", 1)).toBe("h…");
  });

  test("returns sanitized full string when maxChars is zero or negative", () => {
    expect(Text.clip("hello", 0)).toBe("hello");
    expect(Text.clip("a\rb", -5)).toBe("a b");
  });
});

describe("Text.capLines", () => {
  test("clips each line to maxLineChars", () => {
    expect(Text.capLines(["abcdef"], opts({ maxLineChars: 4 }))).toEqual(["abc…"]);
  });

  test("returns all lines when count equals maxLines", () => {
    const lines = ["a", "b", "c"];

    expect(Text.capLines(lines, opts({ maxLines: 3 }))).toEqual(["a", "b", "c"]);
  });

  test("truncates with summary line when over maxLines", () => {
    const lines = ["a", "b", "c", "d", "e"];

    expect(Text.capLines(lines, opts({ maxLines: 3 }))).toEqual(["a", "b", "… (+3 more lines)"]);
  });

  test("keeps at least one real line when maxLines is one", () => {
    expect(Text.capLines(["a", "b", "c"], opts({ maxLines: 1 }))).toEqual(["a", "… (+2 more lines)"]);
  });

  test("returns clipped lines untouched when maxLines is zero or negative", () => {
    const lines = ["a", "b", "c"];

    expect(Text.capLines(lines, opts({ maxLines: 0 }))).toEqual(["a", "b", "c"]);
    expect(Text.capLines(lines, opts({ maxLines: -1 }))).toEqual(["a", "b", "c"]);
  });
});

describe("Text.shortPath", () => {
  test("returns empty string for non-string or empty", () => {
    expect(Text.shortPath(undefined, cwd)).toBe("");
    expect(Text.shortPath(42, cwd)).toBe("");
    expect(Text.shortPath("", cwd)).toBe("");
  });

  test("returns dot when equal to cwd", () => {
    expect(Text.shortPath(cwd, cwd)).toBe(".");
  });

  test("returns relative slice under cwd", () => {
    expect(Text.shortPath(`${cwd}/src/file.ts`, cwd)).toBe("src/file.ts");
  });

  test("prefers cwd over home when cwd is nested inside home", () => {
    const home = homedir();
    const nestedCwd = `${home}/project`;

    expect(Text.shortPath(`${nestedCwd}/file.ts`, nestedCwd)).toBe("file.ts");
    expect(Text.shortPath(nestedCwd, nestedCwd)).toBe(".");
  });

  test("collapses home prefix to tilde when not under cwd", () => {
    const home = homedir();

    expect(Text.shortPath(`${home}/notes.txt`, cwd)).toBe("~/notes.txt");
  });

  test("returns original value when neither cwd nor home match", () => {
    expect(Text.shortPath("/etc/hosts", cwd)).toBe("/etc/hosts");
  });
});

describe("bash renderer", () => {
  test("undefined when command missing or empty", () => {
    expect(previews.bash({})).toBeUndefined();
    expect(previews.bash({ command: "" })).toBeUndefined();
    expect(previews.bash({ command: 5 })).toBeUndefined();
  });

  test("prefixes first line with dollar and indents the rest", () => {
    expect(previews.bash({ command: "ls -la\necho hi\n" })).toEqual(["$ ls -la", "  echo hi"]);
  });
});

describe("read renderer", () => {
  test("undefined when path missing", () => {
    expect(previews.read({}, opts())).toBeUndefined();
  });

  test("plain path with no range", () => {
    expect(previews.read({ path: `${cwd}/a.ts` }, opts())).toEqual(["a.ts"]);
  });

  test("offset and limit produce en-dash range", () => {
    expect(previews.read({ path: `${cwd}/a.ts`, offset: 10, limit: 5 }, opts())).toEqual(["a.ts (lines 10–14)"]);
  });

  test("offset only", () => {
    expect(previews.read({ path: `${cwd}/a.ts`, offset: 10 }, opts())).toEqual(["a.ts (from line 10)"]);
  });

  test("limit only", () => {
    expect(previews.read({ path: `${cwd}/a.ts`, limit: 20 }, opts())).toEqual(["a.ts (first 20 lines)"]);
  });
});

describe("write renderer", () => {
  test("undefined when path missing", () => {
    expect(previews.write({ content: "x" }, opts())).toBeUndefined();
  });

  test("empty content yields zero-line header only", () => {
    expect(previews.write({ path: `${cwd}/a.ts`, content: "" }, opts())).toEqual(["a.ts (0 lines)"]);
  });

  test("singular line label", () => {
    expect(previews.write({ path: `${cwd}/a.ts`, content: "one" }, opts())).toEqual(["a.ts (1 line)", "+ one"]);
  });

  test("plural lines with plus prefix", () => {
    expect(previews.write({ path: `${cwd}/a.ts`, content: "a\nb\n" }, opts())).toEqual(["a.ts (2 lines)", "+ a", "+ b"]);
  });
});

describe("edit renderer single branch", () => {
  test("undefined when path missing", () => {
    expect(previews.edit({ oldText: "x" }, opts())).toBeUndefined();
  });

  test("undefined when oldText not a string and no edits array", () => {
    expect(previews.edit({ path: `${cwd}/a.ts` }, opts())).toBeUndefined();
  });

  test("old text only", () => {
    expect(previews.edit({ path: `${cwd}/a.ts`, oldText: "x\ny" }, opts())).toEqual(["a.ts", "- x", "- y"]);
  });

  test("old and new text", () => {
    expect(previews.edit({ path: `${cwd}/a.ts`, oldText: "x", newText: "z" }, opts())).toEqual(["a.ts", "- x", "+ z"]);
  });

  test("empty newText is ignored", () => {
    expect(previews.edit({ path: `${cwd}/a.ts`, oldText: "x", newText: "" }, opts())).toEqual(["a.ts", "- x"]);
  });
});

describe("edit renderer array branch", () => {
  test("op delete uses minus prefix", () => {
    const out = previews.edit({ path: `${cwd}/a.ts`, edits: [{ op: "delete", line: 3, text: "gone" }] }, opts());

    expect(out).toEqual(["a.ts", "line 3 delete", "- gone"]);
  });

  test("op insert uses plus prefix", () => {
    const out = previews.edit({ path: `${cwd}/a.ts`, edits: [{ op: "insert", line: 7, text: "new" }] }, opts());

    expect(out).toEqual(["a.ts", "line 7 insert", "+ new"]);
  });

  test("anchor string renders the at-prefixed target", () => {
    const out = previews.edit({ path: `${cwd}/a.ts`, edits: [{ op: "insert", anchor: "@func", text: "x" }] }, opts());

    expect(out).toEqual(["a.ts", "@func insert", "+ x"]);
  });

  test("bare anchor is normalized to an at-prefixed target", () => {
    const out = previews.edit({ path: `${cwd}/a.ts`, edits: [{ op: "insert", anchor: "func", text: "x" }] }, opts());

    expect(out).toEqual(["a.ts", "@func insert", "+ x"]);
  });

  test("separator inserted between subsequent edits", () => {
    const out = previews.edit(
      { path: `${cwd}/a.ts`, edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] },
      opts(),
    );

    expect(out).toEqual(["a.ts", "- a", "+ b", "···", "- c", "+ d"]);
  });

  test("non-record edits are skipped but still advance the index", () => {
    const out = previews.edit({ path: `${cwd}/a.ts`, edits: [null, { oldText: "a", newText: "b" }] }, opts());

    expect(out).toEqual(["a.ts", "···", "- a", "+ b"]);
  });

  test("opline with empty text emits only the header", () => {
    const out = previews.edit({ path: `${cwd}/a.ts`, edits: [{ op: "insert", line: 1 }] }, opts());

    expect(out).toEqual(["a.ts", "line 1 insert"]);
  });

  test("replace edit with neither old nor new emits only the path", () => {
    const out = previews.edit({ path: `${cwd}/a.ts`, edits: [{}] }, opts());

    expect(out).toEqual(["a.ts"]);
  });
});

describe("search renderer (grep/find shared)", () => {
  test("undefined when pattern missing or empty", () => {
    expect(previews.search({}, opts())).toBeUndefined();
    expect(previews.search({ pattern: "" }, opts())).toBeUndefined();
  });

  test("defaults location to dot", () => {
    expect(previews.search({ pattern: "foo" }, opts())).toEqual(['"foo" in .']);
  });

  test("extras appended in fixed order", () => {
    const out = previews.search({ pattern: "foo", glob: "*.ts", ignoreCase: true, literal: true }, opts());

    expect(out).toEqual(['"foo" in . (glob *.ts, ignore case, literal)']);
  });

  test("grep and find resolve to the same builtin", () => {
    const a = renderer.renderToolCall("grep", { pattern: "x" }, opts());
    const b = renderer.renderToolCall("find", { pattern: "x" }, opts());

    expect(a).toEqual(b);
  });
});

describe("ls renderer", () => {
  test("returns dot when path missing", () => {
    expect(previews.ls({}, opts())).toEqual(["."]);
  });

  test("returns short path", () => {
    expect(previews.ls({ path: `${cwd}/src` }, opts())).toEqual(["src"]);
  });
});

describe("fallback renderer", () => {
  test("skips undefined values and preserves insertion order", () => {
    const out = previews.fallback({ a: "1", b: undefined, c: "3" });

    expect(out).toEqual(["a: 1", "c: 3"]);
  });

  test("multi-line string value is indented under a header", () => {
    expect(previews.fallback({ note: "x\ny" })).toEqual(["note:", "  x", "  y"]);
  });

  test("non-string values are stringified", () => {
    expect(previews.fallback({ n: 5, flag: true })).toEqual(["n: 5", "flag: true"]);
  });

  test("empty string value yields key with empty value", () => {
    expect(previews.fallback({ k: "" })).toEqual(["k: "]);
  });
});

describe("Renderer.renderToolCall", () => {
  test("custom renderer takes precedence over builtin", () => {
    const custom = new Map([["bash", () => ["custom-line"]]]);

    expect(renderer.renderToolCall("bash", { command: "ls" }, opts(), custom)).toEqual(["custom-line"]);
  });

  test("throwing renderer is swallowed and falls back", () => {
    const custom = new Map([
      [
        "weird",
        () => {
          throw new Error("boom");
        },
      ],
    ]);

    expect(renderer.renderToolCall("weird", { a: "1" }, opts(), custom)).toEqual(["a: 1"]);
  });

  test("non-record input with no renderer yields json-stringified scalar", () => {
    expect(renderer.renderToolCall("unknown", "hello", opts())).toEqual(['"hello"']);
    expect(renderer.renderToolCall("unknown", 42, opts())).toEqual(["42"]);
  });

  test("null or undefined input yields empty list", () => {
    expect(renderer.renderToolCall("unknown", null, opts())).toEqual([]);
    expect(renderer.renderToolCall("unknown", undefined, opts())).toEqual([]);
  });

  test("record input with undefined renderer result uses the fallback renderer", () => {
    expect(renderer.renderToolCall("bash", { command: "" }, opts())).toEqual(["command: "]);
  });

  test("non-string lines are filtered out before capping", () => {
    const custom = new Map<string, () => string[]>([["x", () => ["a", null as unknown as string, "b"]]]);

    expect(renderer.renderToolCall("x", {}, opts(), custom as never)).toEqual(["a", "b"]);
  });
});

describe("Renderer.renderToolCallCompact", () => {
  test("collapses whitespace and trims the first line", () => {
    expect(renderer.renderToolCallCompact("bash", { command: "ls    -la" }, 100, cwd)).toBe("$ ls -la");
  });

  test("appends ellipsis marker when multiple lines", () => {
    const out = renderer.renderToolCallCompact("bash", { command: "a\nb" }, 100, cwd);

    expect(out).toBe("$ a …");
  });

  test("returns empty string for empty first line", () => {
    expect(renderer.renderToolCallCompact("unknown", null, 100, cwd)).toBe("");
  });

  test("clips to maxChars", () => {
    expect(renderer.renderToolCallCompact("bash", { command: "abcdefgh" }, 6, cwd)).toBe("$ abc…");
  });
});
