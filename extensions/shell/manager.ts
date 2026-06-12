import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

export type JobStatus = "running" | "done" | "failed" | "killed";

export interface JobSnapshot {
  id: string;
  command: string;
  pid: number | null;
  status: JobStatus;
  exitCode: number | null;
  exitSignal: string | null;
  startedAt: number;
  endedAt: number | null;
  background: boolean;
  sandboxed: boolean;
  lastLine: string;
  spillPath: string | null;
  bytes: number;
}

export interface RunRequest {
  argv: string[];
  command: string;
  cwd: string;
  sandboxed: boolean;
  timeoutSec: number | null;
  signal: AbortSignal;
  onUpdate: (text: string) => void;
  cleanup: () => void;
}

export interface RunOutcome {
  backgrounded: boolean;
  job: JobSnapshot;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface PeekResult {
  job: JobSnapshot;
  output: string;
}

export interface WaitResult {
  job: JobSnapshot;
  completed: boolean;
}

export interface ManagerOptions {
  capBytes: number;
  autoBackgroundMs: number;
  keepFinished: number;
  onChange: (job: JobSnapshot) => void;
  onBackgroundDone: (job: JobSnapshot, output: string) => void;
}

class RingBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly cap: number) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 0) {
      const head = this.chunks[0];
      const excess = this.size - this.cap;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  tail(maxBytes: number): string {
    if (maxBytes <= 0 || this.size === 0) return "";
    const picked: Buffer[] = [];
    let total = 0;
    for (let i = this.chunks.length - 1; i >= 0 && total < maxBytes; i -= 1) {
      picked.unshift(this.chunks[i]);
      total += this.chunks[i].length;
    }
    let joined = Buffer.concat(picked);
    if (joined.length > maxBytes) joined = joined.subarray(joined.length - maxBytes);
    return joined.toString("utf8");
  }

  bytes(): number {
    return this.size;
  }
}

interface Job {
  id: string;
  command: string;
  sandboxed: boolean;
  child: ChildProcess | null;
  pid: number | null;
  status: JobStatus;
  exitCode: number | null;
  exitSignal: string | null;
  startedAt: number;
  endedAt: number | null;
  background: boolean;
  ring: RingBuffer;
  tailCache: string;
  totalBytes: number;
  spill: WriteStream | null;
  spillPath: string | null;
  waiters: Array<() => void>;
  cleanup: () => void;
  escalation: ReturnType<typeof setTimeout> | null;
  userKilled: boolean;
  timedOut: boolean;
  aborted: boolean;
  finished: boolean;
}

function lastLineOf(tailCache: string): string {
  const trimmed = tailCache.replace(/[\r\n]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\n"), trimmed.lastIndexOf("\r"));
  return (cut === -1 ? trimmed : trimmed.slice(cut + 1)).trim();
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private counter = 0;
  private spillDir: string;

  constructor(
    private readonly options: ManagerOptions,
    spillDir: string,
  ) {
    this.spillDir = spillDir;
  }

  setSpillDir(dir: string): void {
    this.spillDir = dir;
  }

  run(request: RunRequest): Promise<RunOutcome> {
    this.counter += 1;
    const id = `j${this.counter}`;
    const job: Job = {
      id,
      command: request.command,
      sandboxed: request.sandboxed,
      child: null,
      pid: null,
      status: "running",
      exitCode: null,
      exitSignal: null,
      startedAt: Date.now(),
      endedAt: null,
      background: false,
      ring: new RingBuffer(this.options.capBytes),
      tailCache: "",
      totalBytes: 0,
      spill: null,
      spillPath: null,
      waiters: [],
      cleanup: request.cleanup,
      escalation: null,
      userKilled: false,
      timedOut: false,
      aborted: false,
      finished: false,
    };
    this.jobs.set(id, job);
    this.prune();
    try {
      mkdirSync(this.spillDir, { recursive: true });
      const spillPath = join(this.spillDir, `${id}.log`);
      const stream = createWriteStream(spillPath, { flags: "a", mode: 0o600 });
      stream.on("error", () => {
        job.spill = null;
      });
      job.spill = stream;
      job.spillPath = spillPath;
    } catch {
      job.spill = null;
      job.spillPath = null;
    }
    return new Promise<RunOutcome>((settle) => {
      let settled = false;
      let lastEmit = 0;
      let autoTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = (outcome: RunOutcome): void => {
        if (settled) return;
        settled = true;
        settle(outcome);
      };

      const onAbort = (): void => {
        if (job.finished || settled) return;
        job.aborted = true;
        this.terminate(job);
      };

      const finalize = (code: number | null, sig: string | null): void => {
        if (job.finished) return;
        job.finished = true;
        job.endedAt = Date.now();
        job.exitCode = code;
        job.exitSignal = sig;
        job.status = job.userKilled || job.timedOut || job.aborted ? "killed" : code === 0 ? "done" : "failed";
        if (autoTimer !== null) clearTimeout(autoTimer);
        if (timeoutTimer !== null) clearTimeout(timeoutTimer);
        if (job.escalation !== null) {
          clearTimeout(job.escalation);
          job.escalation = null;
        }
        try {
          request.signal.removeEventListener("abort", onAbort);
        } catch {
          job.finished = true;
        }
        if (job.spill !== null) {
          try {
            job.spill.end();
          } catch {
            job.spill = null;
          }
        }
        try {
          job.cleanup();
        } catch {
          job.finished = true;
        }
        const snapshot = this.snapshot(job);
        for (const waiter of job.waiters.splice(0)) waiter();
        if (settled && job.background) {
          try {
            this.options.onBackgroundDone(snapshot, job.ring.text());
          } catch {
            job.finished = true;
          }
        }
        finish({ backgrounded: false, job: snapshot, output: job.ring.text(), timedOut: job.timedOut, aborted: job.aborted });
        this.emitChange(snapshot);
      };

      const onData = (chunk: Buffer): void => {
        job.ring.append(chunk);
        job.totalBytes += chunk.length;
        job.tailCache = (job.tailCache + chunk.toString("utf8")).slice(-4096);
        if (job.spill !== null) {
          try {
            job.spill.write(chunk);
          } catch {
            job.spill = null;
          }
        }
        if (!settled) {
          const now = Date.now();
          if (now - lastEmit >= 250) {
            lastEmit = now;
            try {
              request.onUpdate(job.ring.tail(8192));
            } catch {
              lastEmit = now;
            }
          }
        }
      };

      let child: ChildProcess;
      try {
        child = spawn(request.argv[0], request.argv.slice(1), {
          cwd: request.cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (error) {
        onData(Buffer.from(`[spawn error] ${error instanceof Error ? error.message : String(error)}\n`, "utf8"));
        finalize(null, null);
        return;
      }
      job.child = child;
      job.pid = typeof child.pid === "number" ? child.pid : null;

      if (child.stdout !== null) child.stdout.on("data", onData);
      if (child.stderr !== null) child.stderr.on("data", onData);

      child.on("error", (error: Error) => {
        onData(Buffer.from(`[spawn error] ${error.message}\n`, "utf8"));
        setTimeout(() => finalize(null, null), 25);
      });

      child.on("close", (code, sig) => {
        finalize(code, sig === null ? null : String(sig));
      });

      if (request.timeoutSec !== null) {
        timeoutTimer = setTimeout(() => {
          if (job.finished) return;
          job.timedOut = true;
          this.terminate(job);
        }, request.timeoutSec * 1000);
      } else if (this.options.autoBackgroundMs > 0) {
        autoTimer = setTimeout(() => {
          if (job.finished || settled) return;
          job.background = true;
          try {
            request.signal.removeEventListener("abort", onAbort);
          } catch {
            job.background = true;
          }
          const snapshot = this.snapshot(job);
          finish({ backgrounded: true, job: snapshot, output: job.ring.text(), timedOut: false, aborted: false });
          this.emitChange(snapshot);
        }, this.options.autoBackgroundMs);
      }

      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort);

      this.emitChange(this.snapshot(job));
    });
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((job) => this.snapshot(job));
  }

  get(id: string): JobSnapshot | null {
    const job = this.jobs.get(id);
    return job === undefined ? null : this.snapshot(job);
  }

  peek(id: string): PeekResult | null {
    const job = this.jobs.get(id);
    if (job === undefined) return null;
    return { job: this.snapshot(job), output: job.ring.text() };
  }

  kill(id: string): boolean {
    const job = this.jobs.get(id);
    if (job === undefined || job.finished) return false;
    job.userKilled = true;
    this.terminate(job);
    return true;
  }

  wait(id: string, ms: number): Promise<WaitResult | null> {
    const job = this.jobs.get(id);
    if (job === undefined) return Promise.resolve(null);
    if (job.finished) return Promise.resolve({ job: this.snapshot(job), completed: true });
    return new Promise<WaitResult>((resolveWait) => {
      const timer = setTimeout(() => {
        const index = job.waiters.indexOf(waiter);
        if (index !== -1) job.waiters.splice(index, 1);
        resolveWait({ job: this.snapshot(job), completed: job.finished });
      }, Math.max(0, ms));
      const waiter = (): void => {
        clearTimeout(timer);
        resolveWait({ job: this.snapshot(job), completed: true });
      };
      job.waiters.push(waiter);
    });
  }

  runningCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (!job.finished) count += 1;
    }
    return count;
  }

  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.finished) continue;
      job.userKilled = true;
      this.signalGroup(job, "SIGKILL");
    }
  }

  private terminate(job: Job): void {
    if (job.finished) return;
    this.signalGroup(job, "SIGTERM");
    if (job.escalation === null) {
      job.escalation = setTimeout(() => {
        if (!job.finished) this.signalGroup(job, "SIGKILL");
      }, 1500);
      if (typeof job.escalation.unref === "function") job.escalation.unref();
    }
  }

  private signalGroup(job: Job, sig: NodeJS.Signals): void {
    if (job.pid === null || job.child === null) return;
    try {
      process.kill(-job.pid, sig);
    } catch {
      try {
        job.child.kill(sig);
      } catch {
        job.pid = job.pid;
      }
    }
  }

  private emitChange(snapshot: JobSnapshot): void {
    try {
      this.options.onChange(snapshot);
    } catch {
      return;
    }
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((job) => job.finished);
    const excess = finished.length - Math.max(0, this.options.keepFinished);
    if (excess <= 0) return;
    finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const job of finished.slice(0, excess)) {
      this.jobs.delete(job.id);
    }
  }

  private snapshot(job: Job): JobSnapshot {
    return {
      id: job.id,
      command: job.command,
      pid: job.pid,
      status: job.status,
      exitCode: job.exitCode,
      exitSignal: job.exitSignal,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      background: job.background,
      sandboxed: job.sandboxed,
      lastLine: lastLineOf(job.tailCache),
      spillPath: job.spillPath,
      bytes: job.ring.bytes(),
    };
  }
}
