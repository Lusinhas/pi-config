import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DirEntry, DirectoryReader, DirListing } from "./parse.ts";

export class FsDirectoryReader implements DirectoryReader {
  private static describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }

  private static code(cause: unknown): string | undefined {
    return typeof cause === "object" && cause !== null && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : undefined;
  }

  private static markdownNames(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  }

  list(dir: string): DirListing {
    let names: string[];

    try {
      names = FsDirectoryReader.markdownNames(dir);
    } catch (cause) {
      const code = FsDirectoryReader.code(cause);

      if (code === "ENOENT" || code === "ENOTDIR") {
        return { entries: [], error: null };
      }

      return { entries: [], error: { path: dir, message: `unreadable directory: ${FsDirectoryReader.describe(cause)}` } };
    }

    const entries: DirEntry[] = [];

    for (const name of names) {
      const path = join(dir, name);

      try {
        entries.push({ path, content: readFileSync(path, "utf8"), readError: null });
      } catch (cause) {
        entries.push({ path, content: null, readError: FsDirectoryReader.describe(cause) });
      }
    }

    return { entries, error: null };
  }

  fingerprint(dir: string): string {
    let names: string[];

    try {
      names = FsDirectoryReader.markdownNames(dir);
    } catch {
      return "absent";
    }

    const parts: string[] = [];

    for (const name of names) {
      const path = join(dir, name);

      try {
        const stat = statSync(path);
        parts.push(`${name}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        parts.push(`${name}:missing`);
      }
    }

    return parts.join("|");
  }
}
