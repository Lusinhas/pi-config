import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SnapshotCache, StaleAnchorError } from "../../src/lines/index.ts";
import { DEFAULTS } from "../../src/lines/config.ts";
import type { HashlineConfig } from "../../src/lines/config.ts";
import { Editor } from "../../src/lines/editor.ts";
import type { EditParams } from "../../src/lines/editor.ts";
import { ModeState } from "../../src/lines/mode.ts";

function makeEditor(overrides: Partial<HashlineConfig> = {}): {
  editor: Editor;
  cache: SnapshotCache;
  modeState: ModeState;
  config: HashlineConfig;
} {
  const config: HashlineConfig = { ...DEFAULTS, ...overrides, modes: overrides.modes ?? {} };
  const cache = new SnapshotCache();
  const modeState = new ModeState(config.modes, config.defaultMode);
  const editor = new Editor(cache, config, modeState);

  return { editor, cache, modeState, config };
}

const directQueue = async (_abs: string, run: () => Promise<void>): Promise<void> => {
  await run();
};

async function swallow(promise: Promise<unknown>): Promise<void> {
  await promise.then(
    () => undefined,
    () => undefined,
  );
}

function anchorOf(text: string, lineNumber: number): string {
  for (const line of text.split("\n")) {
    const match = line.match(/^@([A-Za-z0-9_-]{7}) (\d+): /);

    if (match && Number(match[2]) === lineNumber) {
      return match[1];
    }
  }

  throw new Error(`no anchor for line ${lineNumber} in:\n${text}`);
}

describe("Editor", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hashline-editor-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);

    return path;
  }

  describe("whole-file content via edit", () => {
    test("rewrites the entire file without a prior read", async () => {
      const { editor } = makeEditor();
      const path = write("whole.txt", "old line 1\nold line 2\n");

      await editor.edit({ path, content: "fresh A\nfresh B\nfresh C\n" }, dir, directQueue);

      expect(readFileSync(path, "utf8")).toBe("fresh A\nfresh B\nfresh C\n");
    });

    test("rejects content combined with edits and leaves the file untouched", async () => {
      const { editor } = makeEditor();
      const path = write("mix.txt", "a\nb\n");

      await swallow(editor.edit({ path, content: "x", edits: [{ line: 1, op: "replace", text: "y" }] }, dir, directQueue));

      expect(readFileSync(path, "utf8")).toBe("a\nb\n");
    });
  });

  describe("read", () => {
    test("empty file returns marker and resets cache", () => {
      const { editor, cache } = makeEditor();
      const path = write("empty.txt", "");
      const result = editor.read({ path }, dir);
      expect(result.content[0].text).toBe("(empty file)");
      expect(result.details).toEqual({ path, totalLines: 0, start: 0, end: 0, truncated: false, mode: "hashline" });
      expect(cache.has(path)).toBe(true);
    });

    test("renders anchored numbered lines and merges cache", () => {
      const { editor, cache } = makeEditor();
      const path = write("f.txt", "alpha\nbeta\ngamma\n");
      const result = editor.read({ path }, dir);
      const lines = result.content[0].text.split("\n");
      expect(lines[0]).toMatch(/^@[A-Za-z0-9_-]{7} 1: alpha$/);
      expect(lines[1]).toMatch(/^@[A-Za-z0-9_-]{7} 2: beta$/);
      expect(lines[2]).toMatch(/^@[A-Za-z0-9_-]{7} 3: gamma$/);
      expect(result.details.totalLines).toBe(3);
      expect(result.details.truncated).toBe(false);
      expect(cache.lookup(path, 2)).toBe("beta");
    });

    test("offset past end throws", () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\nb\n");
      expect(() => editor.read({ path, offset: 9 }, dir)).toThrow(`offset 9 is past the end of ${path} (2 lines)`);
    });

    test("offset and limit clamp and tail note appears", () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "l1\nl2\nl3\nl4\nl5\n");
      const result = editor.read({ path, offset: 2, limit: 2 }, dir);
      const lines = result.content[0].text.split("\n");
      expect(lines[0]).toMatch(/^@[A-Za-z0-9_-]{7} 2: l2$/);
      expect(lines[1]).toMatch(/^@[A-Za-z0-9_-]{7} 3: l3$/);
      expect(lines[2]).toBe("[showing lines 2-3 of 5; continue with offset=4]");
      expect(result.details.start).toBe(2);
      expect(result.details.end).toBe(3);
      expect(result.details.truncated).toBe(true);
    });

    test("byte budget emits the first line even when oversized", () => {
      const { editor } = makeEditor({ maxBytes: 4 });
      const path = write("f.txt", "abcdefghij\nklm\n");
      const result = editor.read({ path }, dir);
      const lines = result.content[0].text.split("\n");
      expect(lines[0]).toMatch(/^@[A-Za-z0-9_-]{7} 1: abcdefghij$/);
      expect(lines[lines.length - 1]).toContain("[truncated at 4B: showing lines 1-1 of 2; continue with offset=2]");
      expect(result.details.end).toBe(1);
      expect(result.details.truncated).toBe(true);
    });

    test("partial reads accumulate snapshot coverage", () => {
      const { editor, cache } = makeEditor();
      const path = write("f.txt", "a\nb\nc\nd\n");
      editor.read({ path, offset: 1, limit: 2 }, dir);
      editor.read({ path, offset: 3, limit: 2 }, dir);
      expect(cache.lookup(path, 1)).toBe("a");
      expect(cache.lookup(path, 4)).toBe("d");
    });
  });

  describe("applyLineBatch via edit", () => {
    test("rejects file not read this session as stale", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\nb\n");
      let caught: unknown;

      try {
        await editor.edit({ path, edits: [{ line: 1, op: "replace", text: "A" }] }, dir, directQueue);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(StaleAnchorError);
      expect((caught as Error).message).toBe(
        `Edit rejected: ${path} has not been read this session; read it first and target the @hash anchors it shows.`,
      );
    });

    test("empty file rejected before stale check", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "");
      editor.read({ path }, dir);
      await expect(
        editor.edit({ path, edits: [{ line: 1, op: "replace", text: "A" }] }, dir, directQueue),
      ).rejects.toThrow(`${path} is empty; use the write tool to add content`);
    });

    test("applies replace and rewrites file with region body", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\nb\nc\n");
      editor.read({ path }, dir);
      const result = await editor.edit({ path, edits: [{ line: 2, op: "replace", text: "B" }] }, dir, directQueue);
      expect(readFileSync(path, "utf8")).toBe("a\nB\nc\n");
      expect(result.content[0].text).toContain("Edited");
      expect(result.content[0].text).toContain("1 edit(s) applied (1 replace, 0 insert, 0 delete, +0 line(s))");
      expect(result.content[0].text).toContain("Updated region with fresh anchors:");
      expect(result.content[0].text).toMatch(/@[A-Za-z0-9_-]{7} 2: B/);
      expect(result.details).toEqual({
        path,
        form: "anchors",
        applied: 1,
        netDelta: 0,
        totalLines: 3,
        shiftedAnchors: 0,
      });
    });

    test("missing anchor and missing line is a non-stale rejection", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\nb\n");
      editor.read({ path }, dir);
      let caught: unknown;

      try {
        await editor.edit({ path, edits: [{ line: 0, op: "replace", text: "x" }] }, dir, directQueue);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(StaleAnchorError);
      expect((caught as Error).message).toContain("provide anchor from read output");
    });

    test("missing text on non-delete op rejected", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\nb\n");
      editor.read({ path }, dir);
      await expect(
        editor.edit({ path, edits: [{ line: 1, op: "insertafter" }] }, dir, directQueue),
      ).rejects.toThrow('edit 1: op "insertafter" requires text');
    });

    test("line past end is stale", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\nb\n");
      editor.read({ path }, dir);
      await expect(
        editor.edit({ path, edits: [{ line: 5, op: "delete" }] }, dir, directQueue),
      ).rejects.toBeInstanceOf(StaleAnchorError);
    });

    test("line not in latest read is stale", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\nb\nc\nd\n");
      editor.read({ path, offset: 1, limit: 2 }, dir);
      await expect(
        editor.edit({ path, edits: [{ line: 4, op: "delete" }] }, dir, directQueue),
      ).rejects.toThrow("line 4 was not in your most recent read");
    });

    test("changed line on disk is stale", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\nb\nc\n");
      editor.read({ path }, dir);
      writeFileSync(path, "a\nCHANGED\nc\n");
      await expect(
        editor.edit({ path, edits: [{ line: 2, op: "replace", text: "X" }] }, dir, directQueue),
      ).rejects.toThrow("changed since your last read");
    });

    test("conflicting replace and delete on one line is stale", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\nb\nc\n");
      editor.read({ path }, dir);
      await expect(
        editor.edit(
          { path, edits: [{ line: 2, op: "replace", text: "X" }, { line: 2, op: "delete" }] },
          dir,
          directQueue,
        ),
      ).rejects.toThrow("conflicting delete on resolved line 2");
    });

    test("multiple inserts on one line are allowed", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\nb\n");
      editor.read({ path }, dir);
      await editor.edit(
        { path, edits: [{ line: 1, op: "insertafter", text: "X" }, { line: 1, op: "insertbefore", text: "Y" }] },
        dir,
        directQueue,
      );
      expect(readFileSync(path, "utf8")).toBe("Y\na\nX\nb\n");
    });
  });

  describe("anchor addressing via edit", () => {
    test("replace via anchor from read output succeeds", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "alpha\nbeta\ngamma\n");
      const read = editor.read({ path }, dir);
      const anchor = anchorOf(read.content[0].text, 2);
      const result = await editor.edit({ path, edits: [{ anchor, op: "replace", text: "BETA" }] }, dir, directQueue);
      expect(readFileSync(path, "utf8")).toBe("alpha\nBETA\ngamma\n");
      expect(result.details.form).toBe("anchors");
      expect(result.details.shiftedAnchors).toBe(0);
    });

    test("anchor not in latest read is stale", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "alpha\nbeta\n");
      editor.read({ path }, dir);
      await expect(
        editor.edit({ path, edits: [{ anchor: "zzzzzzz", op: "delete" }] }, dir, directQueue),
      ).rejects.toThrow("anchor @zzzzzzz was not in your latest read");
    });

    test("duplicate content anchor without line is ambiguous", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "dup\nother\ndup\n");
      const read = editor.read({ path }, dir);
      const anchor = anchorOf(read.content[0].text, 1);
      await expect(
        editor.edit({ path, edits: [{ anchor, op: "replace", text: "X" }] }, dir, directQueue),
      ).rejects.toThrow("matches 2 cached lines; include the line number");
    });

    test("duplicate content anchor disambiguated by line succeeds", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "dup\nother\ndup\n");
      const read = editor.read({ path }, dir);
      const anchor = anchorOf(read.content[0].text, 3);
      await editor.edit({ path, edits: [{ anchor, line: 3, op: "replace", text: "LAST" }] }, dir, directQueue);
      expect(readFileSync(path, "utf8")).toBe("dup\nother\nLAST\n");
    });

    test("anchor whose line shifted resolves and reports shift", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "alpha\nbeta\ngamma\n");
      const read = editor.read({ path }, dir);
      const anchor = anchorOf(read.content[0].text, 2);
      writeFileSync(path, "header\nalpha\nbeta\ngamma\n");
      const result = await editor.edit({ path, edits: [{ anchor, op: "replace", text: "BETA" }] }, dir, directQueue);
      expect(readFileSync(path, "utf8")).toBe("header\nalpha\nBETA\ngamma\n");
      expect(result.content[0].text).toContain("Resolved shifted anchors");
      expect(result.details.shiftedAnchors).toBe(1);
    });
  });

  describe("edit form selection", () => {
    test("both forms rejected", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\n");
      await expect(
        editor.edit({ path, edits: [{ line: 1, op: "delete" }], oldText: "a", newText: "" }, dir, directQueue),
      ).rejects.toThrow("Provide either edits (line operations) or oldText/newText, not both");
    });

    test("neither form rejected", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\n");
      await expect(editor.edit({ path }, dir, directQueue)).rejects.toThrow(
        "Provide edits: [{anchor, op, text?}] using @hash anchors from the latest read, or the compat form {oldText, newText}",
      );
    });

    test("empty edits array rejected", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\n");
      await expect(editor.edit({ path, edits: [] }, dir, directQueue)).rejects.toThrow(
        "edits must contain at least one operation",
      );
    });

    test("compat disabled in hashline mode when compat=false", async () => {
      const { editor } = makeEditor({ compat: false });
      const path = write("f.txt", "a\n");
      await expect(editor.edit({ path, oldText: "a", newText: "b" }, dir, directQueue)).rejects.toThrow(
        "Plain oldText/newText editing is disabled here; read the file and use hash-anchor edits: {path, edits: [{anchor, op, text?}]}",
      );
    });

    test("compat allowed when mode is compat even with compat=false", async () => {
      const { editor, modeState } = makeEditor({ compat: false });
      modeState.setOverride("compat");
      const path = write("f.txt", "hello\n");
      const result = await editor.edit({ path, oldText: "hello", newText: "world" }, dir, directQueue);
      expect(readFileSync(path, "utf8")).toBe("world\n");
      expect(result.details.form).toBe("compat");
    });
  });

  describe("applyCompat via edit", () => {
    test("unique match replaced", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "one two three\n");
      const result = await editor.edit({ path, oldText: "two", newText: "TWO" }, dir, directQueue);
      expect(readFileSync(path, "utf8")).toBe("one TWO three\n");
      expect(result.details).toEqual({ path, form: "compat", applied: 1, netDelta: 0, totalLines: 1 });
    });

    test("empty oldText rejected", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\n");
      await expect(editor.edit({ path, oldText: "", newText: "x" }, dir, directQueue)).rejects.toThrow(
        "oldText must not be empty",
      );
    });

    test("identical texts rejected", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\n");
      await expect(editor.edit({ path, oldText: "a", newText: "a" }, dir, directQueue)).rejects.toThrow(
        "oldText and newText are identical; nothing to change",
      );
    });

    test("not found rejected", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "abc\n");
      await expect(editor.edit({ path, oldText: "zzz", newText: "x" }, dir, directQueue)).rejects.toThrow(
        `oldText was not found in ${path}`,
      );
    });

    test("multiple matches rejected", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "ab ab\n");
      await expect(editor.edit({ path, oldText: "ab", newText: "x" }, dir, directQueue)).rejects.toThrow(
        `oldText matches 2 places in ${path}; add surrounding context so the match is unique`,
      );
    });

    test("crlf fallback matches lf oldText against crlf file and restores crlf", async () => {
      const { editor } = makeEditor();
      const path = write("f.txt", "a\r\nb\r\nc\r\n");
      const result = await editor.edit({ path, oldText: "a\nb", newText: "a\nB" }, dir, directQueue);
      expect(readFileSync(path, "utf8")).toBe("a\r\nB\r\nc\r\n");
      expect(result.details.form).toBe("compat");
    });
  });

  describe("statusText", () => {
    test("initial status with no model", () => {
      const { editor } = makeEditor();
      expect(editor.statusText()).toBe(
        "hashline mode: hashline (default) | edits applied: 0 | rejected: 0 | stale: 0 (0.0% stale rate)",
      );
    });

    test("includes model note and stale rate after activity", async () => {
      const { editor, modeState } = makeEditor();
      modeState.setModel("claude-x");
      const path = write("f.txt", "a\nb\n");
      editor.read({ path }, dir);
      await swallow(editor.edit({ path, edits: [{ line: 9, op: "delete" }] }, dir, directQueue));
      const status = editor.statusText();
      expect(status).toContain("model: claude-x");
      expect(status).toContain("rejected: 1");
      expect(status).toContain("stale: 1");
      expect(status).toContain("100.0% stale rate");
    });
  });

  describe("completions", () => {
    test("returns fixed order when prefix empty", () => {
      const { editor } = makeEditor();
      const items = editor.completions("");
      expect(items?.map((i) => i.value)).toEqual(["toggle", "hashline", "compat", "auto"]);
    });

    test("filters by prefix", () => {
      const { editor } = makeEditor();
      expect(editor.completions("h")?.map((i) => i.value)).toEqual(["hashline"]);
    });

    test("null when nothing matches", () => {
      const { editor } = makeEditor();
      expect(editor.completions("zzz")).toBeNull();
    });
  });

  describe("command", () => {
    test("empty arg reports status as info", () => {
      const { editor } = makeEditor();
      expect(editor.command("").level).toBe("info");
      expect(editor.command("").message).toContain("hashline mode:");
    });

    test("toggle flips mode and marks manual override", () => {
      const { editor } = makeEditor();
      const result = editor.command("toggle");
      expect(result.message).toBe("hashline mode: compat (manual override; /hashline auto to follow the model mapping)");
    });

    test("explicit mode sets override", () => {
      const { editor } = makeEditor();
      const result = editor.command("compat");
      expect(result.message).toBe("hashline mode: compat (manual override; /hashline auto to follow the model mapping)");
    });

    test("auto clears override and reports mapping origin", () => {
      const { editor } = makeEditor();
      editor.command("compat");
      const result = editor.command("auto");
      expect(result.message).toBe("hashline mode: hashline (default via model mapping)");
    });

    test("unknown argument is an error", () => {
      const { editor } = makeEditor();
      const result = editor.command("bogus");
      expect(result.level).toBe("error");
      expect(result.message).toBe('Unknown argument "bogus". Usage: /hashline [toggle|hashline|compat|auto]');
    });
  });

  describe("session lifecycle", () => {
    test("startSession clears cache and stats and sets model", async () => {
      const { editor, cache } = makeEditor();
      const path = write("f.txt", "a\nb\n");
      editor.read({ path }, dir);
      await swallow(editor.edit({ path, edits: [{ line: 9, op: "delete" }] }, dir, directQueue));
      editor.startSession("new-model");
      expect(cache.has(path)).toBe(false);
      const status = editor.statusText();
      expect(status).toContain("edits applied: 0");
      expect(status).toContain("rejected: 0");
      expect(status).toContain("model: new-model");
    });

    test("selectModel updates mode mapping", () => {
      const { editor, modeState } = makeEditor({ modes: { "gpt-*": "compat" } });
      editor.selectModel("gpt-4");
      expect(modeState.current()).toBe("compat");
    });
  });

  function buildParams(p: EditParams): EditParams {
    return p;
  }

  test("edit params interface accepts full shape", () => {
    const p = buildParams({ path: "x", edits: [{ anchor: "abc1234", line: 1, op: "delete" }], oldText: "a", newText: "b" });
    expect(p.path).toBe("x");
  });
});
