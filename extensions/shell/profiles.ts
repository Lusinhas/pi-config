import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SandboxNetwork = "full" | "none";

export interface WrittenProfile {
  path: string;
  cleanup: () => void;
}

function escapeProfilePath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildProfile(writable: string[], network: SandboxNetwork): string {
  const lines: string[] = ["(version 1)", "(allow default)", "(deny file-write*)"];
  const unique = [...new Set(writable)].filter((path) => path.startsWith("/"));
  for (const path of unique) {
    lines.push(`(allow file-write* (subpath "${escapeProfilePath(path)}"))`);
  }
  lines.push('(allow file-write* (literal "/dev/null"))');
  lines.push('(allow file-write* (literal "/dev/dtracehelper"))');
  lines.push('(allow file-write-data (regex #"^/dev/tty"))');
  if (network === "none") {
    lines.push("(deny network*)");
  }
  return `${lines.join("\n")}\n`;
}

export function writeProfile(writable: string[], network: SandboxNetwork): WrittenProfile {
  const dir = mkdtempSync(join(tmpdir(), "pisandbox"));
  const path = join(dir, "profile.sb");
  writeFileSync(path, buildProfile(writable, network), { mode: 0o600 });
  let removed = false;
  return {
    path,
    cleanup: (): void => {
      if (removed) return;
      removed = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        removed = true;
      }
    },
  };
}
