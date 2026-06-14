import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ContentIntegrity } from "../../src/permissions/integrity.ts";

const integrity = new ContentIntegrity();
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(0x7f);

const PACKAGES_ROOT = join(import.meta.dir, "..", "..", "..");
const ALLOWED_BYTES = new Set([0x09, 0x0a, 0x0d]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }

    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      found.push(full);
    }
  }

  return found;
}

function rawControlByte(bytes: Buffer): { offset: number; byte: number } | undefined {
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];

    if (byte === 0x7f || (byte < 0x20 && !ALLOWED_BYTES.has(byte))) {
      return { offset: i, byte };
    }
  }

  return undefined;
}

describe("ContentIntegrity.violation", () => {
  test("blocks a NUL byte in write content", () => {
    const reason = integrity.violation("write", { path: "a.ts", content: `a${NUL}b` });

    expect(reason).toContain("non-text content into a.ts");
    expect(reason).toContain("U+0000");
    expect(reason).toContain("offset 1");
  });

  test("blocks a control byte introduced by an edit", () => {
    const reason = integrity.violation("edit", { path: "b.ts", edits: [{ oldText: "x", newText: `y${BEL}z` }] });

    expect(reason).toContain("non-text content into b.ts");
    expect(reason).toContain("U+0007");
  });

  test("allows tab, newline, and carriage return", () => {
    const content = `a${String.fromCharCode(9)}b${String.fromCharCode(10)}c${String.fromCharCode(13)}`;

    expect(integrity.violation("write", { path: "c.ts", content })).toBeUndefined();
  });

  test("allows ordinary unicode text", () => {
    expect(integrity.violation("write", { path: "d.ts", content: "const e = x … y" })).toBeUndefined();
  });

  test("blocks the DEL byte", () => {
    expect(integrity.violation("write", { path: "e.ts", content: `a${DEL}b` })).toContain("U+007F");
  });

  test("ignores tools other than write and edit", () => {
    expect(integrity.violation("bash", { command: "printf x" })).toBeUndefined();
  });

  test("ignores malformed input", () => {
    expect(integrity.violation("write", undefined)).toBeUndefined();
    expect(integrity.violation("edit", { path: "f.ts", edits: "nope" })).toBeUndefined();
  });
});

describe("repository source integrity", () => {
  test("no package source file contains raw control bytes", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(PACKAGES_ROOT)) {
      const hit = rawControlByte(readFileSync(file));

      if (hit !== undefined) {
        offenders.push(`${file}: byte 0x${hit.byte.toString(16).padStart(2, "0")} at offset ${hit.offset}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
