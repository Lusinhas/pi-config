import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { findAll, formatSize, loadFile, resolvePath } from "../../src/lines/disk.ts";

describe("formatSize", () => {
  test("bytes under 1KB", () => {
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(1023)).toBe("1023B");
  });

  test("kilobytes with one decimal", () => {
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(51200)).toBe("50.0KB");
  });

  test("megabytes with one decimal", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0MB");
    expect(formatSize(64 * 1024 * 1024)).toBe("64.0MB");
  });
});

describe("findAll", () => {
  test("finds non-overlapping occurrences", () => {
    expect(findAll("aaaa", "aa")).toEqual([0, 2]);
  });

  test("empty when needle absent", () => {
    expect(findAll("abc", "z")).toEqual([]);
  });

  test("single occurrence", () => {
    expect(findAll("hello world", "world")).toEqual([6]);
  });
});

describe("resolvePath", () => {
  test("rejects non-string and blank", () => {
    expect(() => resolvePath(5, "/cwd")).toThrow("path must be a non-empty string");
    expect(() => resolvePath("   ", "/cwd")).toThrow("path must be a non-empty string");
    expect(() => resolvePath("", "/cwd")).toThrow("path must be a non-empty string");
  });

  test("tilde expands to home", () => {
    expect(resolvePath("~", "/cwd")).toBe(homedir());
  });

  test("tilde slash expands relative to home", () => {
    expect(resolvePath("~/sub/file", "/cwd")).toBe(join(homedir(), "sub/file"));
  });

  test("absolute path normalizes", () => {
    expect(resolvePath("/a/b/../c", "/cwd")).toBe("/a/c");
  });

  test("relative path resolves against cwd", () => {
    expect(resolvePath("rel/file", "/base")).toBe("/base/rel/file");
  });
});

describe("loadFile", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hashline-fileio-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file", () => {
    expect(() => loadFile(join(dir, "nope.txt"))).toThrow(`File not found: ${join(dir, "nope.txt")}`);
  });

  test("directory rejected", () => {
    const sub = join(dir, "adir");
    mkdirSync(sub);
    expect(() => loadFile(sub)).toThrow(`${sub} is a directory; use ls or find instead`);
  });

  test("binary file rejected", () => {
    const bin = join(dir, "bin.dat");
    writeFileSync(bin, Buffer.from([0x68, 0x00, 0x69]));
    expect(() => loadFile(bin)).toThrow(`${bin} looks like a binary file; hashline read and edit only support text files`);
  });

  test("text file loads and parses", () => {
    const txt = join(dir, "ok.txt");
    writeFileSync(txt, "a\nb\n");
    const loaded = loadFile(txt);
    expect(loaded.content).toBe("a\nb\n");
    expect(loaded.parsed.lines).toEqual(["a", "b"]);
  });
});
