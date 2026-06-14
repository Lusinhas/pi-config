import type { GitInfo } from "./index.ts";

export type GitExec = (
  command: string,
  args: string[],
  options: { timeout: number }
) => Promise<{ stdout: string; code: number }>;

export class GitWatcher {
  #exec: GitExec;
  #intervalMs: number;
  #timeoutMs: number;
  #info: GitInfo | null = null;
  #cwd: string | null = null;
  #fetchedAt = 0;
  #inFlight = false;

  constructor(exec: GitExec, intervalMs: number, timeoutMs: number) {
    this.#exec = exec;
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
  }

  current(): GitInfo | null {
    return this.#info;
  }

  poll(cwd: string, onChange: () => void): void {
    if (this.#inFlight) {
      return;
    }

    const now = Date.now();

    if (cwd === this.#cwd && now - this.#fetchedAt < this.#intervalMs) {
      return;
    }

    this.#inFlight = true;
    this.#refresh(cwd)
      .then(next => {
        this.#finish(cwd);

        const previous = this.#info;
        const changed =
          (next === null) !== (previous === null) ||
          (next !== null &&
            previous !== null &&
            (next.branch !== previous.branch || next.dirty !== previous.dirty));

        this.#info = next;

        if (changed) {
          onChange();
        }
      })
      .catch(() => {
        this.#finish(cwd);
      });
  }

  #finish(cwd: string): void {
    this.#cwd = cwd;
    this.#fetchedAt = Date.now();
    this.#inFlight = false;
  }

  async #refresh(cwd: string): Promise<GitInfo | null> {
    const head = await this.#exec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: this.#timeoutMs
    });

    if (head.code !== 0) {
      return null;
    }

    let branch = head.stdout.trim();

    if (branch === "") {
      return null;
    }

    if (branch === "HEAD") {
      const sha = await this.#exec("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
        timeout: this.#timeoutMs
      });

      branch = sha.code === 0 && sha.stdout.trim() !== "" ? `@${sha.stdout.trim()}` : "@detached";
    }

    const status = await this.#exec("git", ["-C", cwd, "status", "--porcelain"], {
      timeout: this.#timeoutMs
    });
    const dirty = status.code === 0 && status.stdout.trim() !== "";

    return { branch, dirty };
  }
}
