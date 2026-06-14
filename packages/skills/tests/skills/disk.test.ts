import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsRead } from "../../src/skills/disk.ts";

describe("FsRead", () => {
  let root: string;
  let fs: FsRead;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fsread-"));
    fs = new FsRead();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("isDirectory and isFile distinguish kinds and missing paths", () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    const file = join(root, "f.txt");
    writeFileSync(file, "x");
    expect(fs.isDirectory(dir)).toBe(true);
    expect(fs.isDirectory(file)).toBe(false);
    expect(fs.isFile(file)).toBe(true);
    expect(fs.isFile(dir)).toBe(false);
    expect(fs.isFile(join(root, "missing"))).toBe(false);
    expect(fs.isDirectory(join(root, "missing"))).toBe(false);
  });

  test("readEntries returns dirents and empty on error", () => {
    mkdirSync(join(root, "child"));
    writeFileSync(join(root, "file.txt"), "x");
    const names = fs.readEntries(root).map(e => e.name).sort();
    expect(names).toEqual(["child", "file.txt"]);
    expect(fs.readEntries(join(root, "missing"))).toEqual([]);
  });

  test("readJson returns record for object json", () => {
    const path = join(root, "obj.json");
    writeFileSync(path, JSON.stringify({ a: 1 }));
    expect(fs.readJson(path)).toEqual({ a: 1 });
  });

  test("readJson returns null for arrays, scalars, and invalid json", () => {
    const arr = join(root, "arr.json");
    writeFileSync(arr, JSON.stringify([1, 2]));
    expect(fs.readJson(arr)).toBeNull();

    const scalar = join(root, "scalar.json");
    writeFileSync(scalar, JSON.stringify(7));
    expect(fs.readJson(scalar)).toBeNull();

    const bad = join(root, "bad.json");
    writeFileSync(bad, "{not json");
    expect(fs.readJson(bad)).toBeNull();

    expect(fs.readJson(join(root, "missing.json"))).toBeNull();
  });

  test("readJson returns null for explicit json null", () => {
    const path = join(root, "null.json");
    writeFileSync(path, "null");
    expect(fs.readJson(path)).toBeNull();
  });

  test("realPath resolves symlinks and falls back to input on error", () => {
    const target = join(root, "target");
    mkdirSync(target);
    const link = join(root, "link");
    symlinkSync(target, link);
    expect(fs.realPath(link)).toBe(fs.realPath(target));
    const missing = join(root, "missing");
    expect(fs.realPath(missing)).toBe(missing);
  });

  test("isRecord guard", () => {
    expect(fs.isRecord({})).toBe(true);
    expect(fs.isRecord([])).toBe(false);
    expect(fs.isRecord(null)).toBe(false);
  });
});
