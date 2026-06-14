import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";

export class FsRead {
  isDirectory(path: string): boolean {
    try {

      return statSync(path).isDirectory();
    } catch {

      return false;
    }
  }

  isFile(path: string): boolean {
    try {

      return statSync(path).isFile();
    } catch {

      return false;
    }
  }

  readEntries(dir: string): Dirent[] {
    try {

      return readdirSync(dir, { withFileTypes: true });
    } catch {

      return [];
    }
  }

  readJson(path: string | URL): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

      return this.isRecord(parsed) ? parsed : null;
    } catch {

      return null;
    }
  }

  realPath(path: string): string {
    try {

      return realpathSync(path);
    } catch {

      return path;
    }
  }

  mtimeMs(path: string | URL): number {
    try {

      return statSync(path).mtimeMs;
    } catch {

      return 0;
    }
  }

  isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
