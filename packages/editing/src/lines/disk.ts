import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { parseContent } from "./index.ts";
import type { ParsedFile } from "./index.ts";
import { LARGE_FILE_BYTES } from "./config.ts";

export interface LoadedFile {
  content: string;
  parsed: ParsedFile;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function findAll(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let cursor = 0;

  while (cursor <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, cursor);

    if (at === -1) {
      break;
    }

    positions.push(at);
    cursor = at + needle.length;
  }

  return positions;
}

export function resolvePath(path: unknown, cwd: string): string {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("path must be a non-empty string");
  }

  const trimmed = path.trim();
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? join(homedir(), trimmed.slice(2))
        : trimmed;

  return isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);
}

export function loadFile(abs: string): LoadedFile {
  let info;

  try {
    info = statSync(abs);
  } catch {
    throw new Error(`File not found: ${abs}`);
  }

  if (info.isDirectory()) {
    throw new Error(`${abs} is a directory; use ls or find instead`);
  }

  if (!info.isFile()) {
    throw new Error(`${abs} is not a regular file`);
  }

  if (info.size > LARGE_FILE_BYTES) {
    throw new Error(
      `${abs} is ${formatSize(info.size)}, larger than the ${formatSize(LARGE_FILE_BYTES)} hashline limit; use bash tools (grep, sed, head) instead`,
    );
  }

  const buffer = readFileSync(abs);

  if (buffer.subarray(0, 8192).includes(0)) {
    throw new Error(`${abs} looks like a binary file; hashline read and edit only support text files`);
  }

  const content = buffer.toString("utf8");

  return { content, parsed: parseContent(content) };
}
