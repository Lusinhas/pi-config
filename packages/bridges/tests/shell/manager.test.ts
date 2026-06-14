import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JobSnapshot, JobManager, type ManagerOptions, RingBuffer } from "../../src/shell/index.ts";

function options(overrides: Partial<ManagerOptions> = {}): ManagerOptions {
  return {
    capBytes: 1_000_000,
    autoBackgroundMs: 0,
    keepFinished: 20,
    onChange: () => void 0,
    onBackgroundDone: () => void 0,
    ...overrides,
  };
}

function newManager(overrides: Partial<ManagerOptions> = {}): JobManager {
  const dir = mkdtempSync(join(tmpdir(), "jobs"));

  return new JobManager(options(overrides), dir);
}

function shArgv(command: string): string[] {
  return ["/bin/sh", "-c", command];
}

const noSignal = new AbortController().signal;

describe("RingBuffer", () => {
  test("bytes tracks appended size", () => {
    const ring = new RingBuffer(100);
    ring.append(Buffer.from("abc"));

    expect(ring.bytes()).toBe(3);
    expect(ring.text()).toBe("abc");
  });

  test("empty append is ignored", () => {
    const ring = new RingBuffer(100);
    ring.append(Buffer.alloc(0));

    expect(ring.bytes()).toBe(0);
  });

  test("trims oldest whole chunks beyond cap", () => {
    const ring = new RingBuffer(3);
    ring.append(Buffer.from("aaa"));
    ring.append(Buffer.from("bbb"));

    expect(ring.bytes()).toBe(3);
    expect(ring.text()).toBe("bbb");
  });

  test("trims a partial head chunk when removing it whole would underflow", () => {
    const ring = new RingBuffer(5);
    ring.append(Buffer.from("aaa"));
    ring.append(Buffer.from("bbb"));

    expect(ring.bytes()).toBe(5);
    expect(ring.text()).toBe("aabbb");
  });

  test("trims partial head when needed", () => {
    const ring = new RingBuffer(4);
    ring.append(Buffer.from("123456"));

    expect(ring.bytes()).toBe(4);
    expect(ring.text()).toBe("3456");
  });

  test("tail walks from the end and respects maxBytes", () => {
    const ring = new RingBuffer(100);
    ring.append(Buffer.from("hello"));
    ring.append(Buffer.from("world"));

    expect(ring.tail(4)).toBe("orld");
    expect(ring.tail(0)).toBe("");
  });

  test("tail of empty buffer is empty", () => {
    expect(new RingBuffer(10).tail(5)).toBe("");
  });
});

describe("JobManager run", () => {
  test("foreground success captures output and exit 0", async () => {
    const manager = newManager();
    const outcome = await manager.run({
      argv: shArgv("printf 'hello\\n'"),
      command: "printf hello",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });

    expect(outcome.backgrounded).toBe(false);
    expect(outcome.job.status).toBe("done");
    expect(outcome.job.exitCode).toBe(0);
    expect(outcome.output).toBe("hello\n");
  });

  test("non-zero exit yields failed status", async () => {
    const manager = newManager();
    const outcome = await manager.run({
      argv: shArgv("exit 3"),
      command: "exit 3",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });

    expect(outcome.job.status).toBe("failed");
    expect(outcome.job.exitCode).toBe(3);
  });

  test("spill log written and readable", async () => {
    const manager = newManager();
    const outcome = await manager.run({
      argv: shArgv("printf 'spilled'"),
      command: "printf spilled",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });

    expect(outcome.job.spillPath).not.toBeNull();
    expect(readFileSync(outcome.job.spillPath as string, "utf8")).toBe("spilled");
  });

  test("cleanup callback runs on finish", async () => {
    const manager = newManager();
    let cleaned = false;
    await manager.run({
      argv: shArgv("true"),
      command: "true",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => {
        cleaned = true;
      },
    });

    expect(cleaned).toBe(true);
  });

  test("auto-background after threshold returns a job id", async () => {
    const seen: JobSnapshot[] = [];
    const manager = newManager({
      autoBackgroundMs: 50,
      onBackgroundDone: (job) => seen.push(job),
    });
    const outcome = await manager.run({
      argv: shArgv("sleep 1; printf done"),
      command: "sleep 1",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });

    expect(outcome.backgrounded).toBe(true);
    expect(outcome.job.background).toBe(true);
    expect(outcome.job.status).toBe("running");

    const finished = await manager.wait(outcome.job.id, 4000);

    expect(finished?.completed).toBe(true);
    expect(seen.some((job) => job.id === outcome.job.id)).toBe(true);
  });

  test("timeout disables auto-background and kills the job", async () => {
    const manager = newManager({ autoBackgroundMs: 10 });
    const outcome = await manager.run({
      argv: shArgv("sleep 5"),
      command: "sleep 5",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: 1,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });

    expect(outcome.backgrounded).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.job.status).toBe("killed");
  });

  test("abort signal terminates the job", async () => {
    const manager = newManager();
    const controller = new AbortController();
    const promise = manager.run({
      argv: shArgv("sleep 5"),
      command: "sleep 5",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: controller.signal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });
    setTimeout(() => controller.abort(), 50);
    const outcome = await promise;

    expect(outcome.aborted).toBe(true);
    expect(outcome.job.status).toBe("killed");
  });

  test("spawn failure surfaces a failed start", async () => {
    const manager = newManager();
    const outcome = await manager.run({
      argv: ["/no/such/binary/anywhere"],
      command: "missing",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });

    expect(outcome.job.status).toBe("failed");
    expect(outcome.output).toContain("[spawn error]");
  });
});

describe("JobManager job control", () => {
  test("list, get, and peek reflect completed job", async () => {
    const manager = newManager();
    const outcome = await manager.run({
      argv: shArgv("printf out"),
      command: "printf out",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });
    const id = outcome.job.id;

    expect(manager.list().some((job) => job.id === id)).toBe(true);
    expect(manager.get(id)?.status).toBe("done");
    expect(manager.peek(id)?.output).toBe("out");
    expect(manager.get("nope")).toBeNull();
    expect(manager.peek("nope")).toBeNull();
  });

  test("ids increment sequentially", async () => {
    const manager = newManager();
    const a = await manager.run({
      argv: shArgv("true"),
      command: "a",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });
    const b = await manager.run({
      argv: shArgv("true"),
      command: "b",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });

    expect(a.job.id).toBe("j1");
    expect(b.job.id).toBe("j2");
  });

  test("wait on unknown job resolves null", async () => {
    const manager = newManager();

    expect(await manager.wait("ghost", 10)).toBeNull();
  });

  test("kill returns false for unknown or finished job", async () => {
    const manager = newManager();
    const outcome = await manager.run({
      argv: shArgv("true"),
      command: "done",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });

    expect(manager.kill("ghost")).toBe(false);
    expect(manager.kill(outcome.job.id)).toBe(false);
  });

  test("prune keeps at most keepFinished finished jobs, oldest deleted first", async () => {
    const manager = newManager({ keepFinished: 1 });
    const first = await manager.run({
      argv: shArgv("true"),
      command: "first",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });
    const second = await manager.run({
      argv: shArgv("true"),
      command: "second",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });
    const third = await manager.run({
      argv: shArgv("true"),
      command: "third",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });

    expect(manager.get(first.job.id)).toBeNull();
    expect(manager.get(second.job.id)).not.toBeNull();
    expect(manager.get(third.job.id)).not.toBeNull();
  });

  test("runningCount and killAll on a live job", async () => {
    const manager = newManager();
    const promise = manager.run({
      argv: shArgv("sleep 5"),
      command: "sleep 5",
      cwd: process.cwd(),
      sandboxed: false,
      timeoutSec: null,
      signal: noSignal,
      onUpdate: () => void 0,
      cleanup: () => void 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(manager.runningCount()).toBe(1);

    manager.killAll();
    const outcome = await promise;

    expect(outcome.job.status).toBe("killed");
    expect(manager.runningCount()).toBe(0);
  });
});
