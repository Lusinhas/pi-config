import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TodoStore } from "./index.ts";

export class TodoMirror {
  constructor(private readonly store: TodoStore) {}

  mirrorPath(cwd: string): string {
    const project = this.realProject(cwd);
    const hash = createHash("sha1").update(project).digest("hex").slice(0, 12);

    return join(this.mirrorDir(), `${hash}.json`);
  }

  writeMirror(cwd: string): void {
    const dir = this.mirrorDir();

    mkdirSync(dir, { recursive: true });

    const target = this.mirrorPath(cwd);
    const payload = `${JSON.stringify({ project: cwd, todos: this.store.snapshot() }, null, 2)}\n`;
    const temp = `${target}.${process.pid}.tmp`;

    writeFileSync(temp, payload, "utf8");
    renameSync(temp, target);
  }

  private realProject(cwd: string): string {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  }

  private mirrorDir(): string {
    return join(homedir(), ".pi", "agent", "todos");
  }
}
