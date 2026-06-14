import { describe, expect, test } from "bun:test";
import type { JobSnapshot } from "../../src/shell/index.ts";
import { Renderer, type TruncateFn } from "../../src/shell/widget.ts";

const passthrough: TruncateFn = (text) => ({ content: text, truncated: false });

function job(overrides: Partial<JobSnapshot>): JobSnapshot {
  return {
    id: "j1",
    command: "echo hi",
    pid: 100,
    status: "running",
    exitCode: null,
    exitSignal: null,
    startedAt: 0,
    endedAt: null,
    background: false,
    sandboxed: false,
    lastLine: "",
    spillPath: null,
    bytes: 0,
    ...overrides,
  };
}

describe("clip", () => {
  test("returns empty for non-positive max", () => {
    expect(Renderer.clip("hello", 0)).toBe("");
  });

  test("returns text unchanged when within max", () => {
    expect(Renderer.clip("hi", 5)).toBe("hi");
  });

  test("ellipsis only for max 1", () => {
    expect(Renderer.clip("hello", 1)).toBe("…");
  });

  test("truncates with trailing ellipsis", () => {
    expect(Renderer.clip("hello", 3)).toBe("he…");
  });
});

describe("normalize", () => {
  test("collapses whitespace and trims", () => {
    expect(Renderer.normalize("  a\t b\n c ")).toBe("a b c");
  });
});

describe("formatRuntime", () => {
  test("sub-hour uses mm:ss", () => {
    expect(Renderer.formatRuntime(0)).toBe("00:00");
    expect(Renderer.formatRuntime(65000)).toBe("01:05");
  });

  test("hours add h:mm:ss", () => {
    expect(Renderer.formatRuntime(3_661_000)).toBe("1:01:01");
  });

  test("negative clamps to zero", () => {
    expect(Renderer.formatRuntime(-500)).toBe("00:00");
  });
});

describe("describeEnd", () => {
  test("done", () => {
    expect(Renderer.describeEnd(job({ status: "done", exitCode: 0 }))).toBe("completed successfully (exit 0)");
  });

  test("killed with signal", () => {
    expect(Renderer.describeEnd(job({ status: "killed", exitSignal: "SIGKILL" }))).toBe("was killed (SIGKILL)");
  });

  test("killed without signal", () => {
    expect(Renderer.describeEnd(job({ status: "killed", exitSignal: null }))).toBe("was killed");
  });

  test("failed with exit code", () => {
    expect(Renderer.describeEnd(job({ status: "failed", exitCode: 2 }))).toBe("failed (exit 2)");
  });

  test("failed with signal only", () => {
    expect(Renderer.describeEnd(job({ status: "failed", exitCode: null, exitSignal: "SIGSEGV" }))).toBe(
      "failed (signal SIGSEGV)",
    );
  });

  test("failed with neither", () => {
    expect(Renderer.describeEnd(job({ status: "failed", exitCode: null, exitSignal: null }))).toBe("failed");
  });
});

describe("renderJobs", () => {
  const render = new Renderer(passthrough);

  test("ignores non-running jobs", () => {
    expect(render.renderJobs([job({ status: "done" })], 1000, 5)).toEqual([]);
  });

  test("formats a running job line with last output", () => {
    const lines = render.renderJobs(
      [job({ id: "j2", command: "make build", lastLine: "compiling", startedAt: 0 })],
      65000,
      5,
    );

    expect(lines).toEqual(["▶ j2 01:05 make build · compiling"]);
  });

  test("caps and reports overflow", () => {
    const jobs = [job({ id: "j1" }), job({ id: "j2" }), job({ id: "j3" })];
    const lines = render.renderJobs(jobs, 0, 2);

    expect(lines.length).toBe(3);
    expect(lines[2]).toBe("… 1 more running");
  });

  test("limit below 1 still shows one line", () => {
    const lines = render.renderJobs([job({ id: "j1" }), job({ id: "j2" })], 0, 0);

    expect(lines[0]?.startsWith("▶ j1")).toBe(true);
    expect(lines[1]).toBe("… 1 more running");
  });
});

describe("formatJobList", () => {
  const render = new Renderer(passthrough);

  test("empty list", () => {
    expect(render.formatJobList([], 0)).toBe("No jobs.");
  });

  test("running job uses dash exit and fg/bg kind", () => {
    const line = render.formatJobList([job({ id: "j1", status: "running", background: true, startedAt: 0 })], 0);

    expect(line).toBe("j1  running  bg  00:00  exit:-  echo hi");
  });

  test("finished job shows exit code", () => {
    const line = render.formatJobList(
      [job({ id: "j1", status: "done", exitCode: 0, background: false, startedAt: 0, endedAt: 2000 })],
      5000,
    );

    expect(line).toBe("j1  done  fg  00:02  exit:0  echo hi");
  });

  test("signalled job shows signal, falling back to ?", () => {
    const withSig = render.formatJobList([job({ id: "j1", status: "killed", exitCode: null, exitSignal: "SIGTERM", startedAt: 0, endedAt: 0 })], 0);
    const noSig = render.formatJobList([job({ id: "j2", status: "killed", exitCode: null, exitSignal: null, startedAt: 0, endedAt: 0 })], 0);

    expect(withSig).toContain("exit:SIGTERM");
    expect(noSig).toContain("exit:?");
  });
});

describe("cleanOutput", () => {
  test("strips ANSI CSI colors", () => {
    expect(Renderer.cleanOutput("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  test("strips OSC sequences terminated by BEL", () => {
    expect(Renderer.cleanOutput("before\x1b]0;title\x07after")).toBe("beforeafter");
  });

  test("strips OSC sequences terminated by ST", () => {
    expect(Renderer.cleanOutput("a\x1b]8;;http://x\x1b\\b")).toBe("ab");
  });

  test("collapses carriage-return overwrites per line", () => {
    expect(Renderer.cleanOutput("10%\r50%\r100%\ndone")).toBe("100%\ndone");
  });

  test("trailing CR is dropped", () => {
    expect(Renderer.cleanOutput("tail\r")).toBe("tail");
  });

  test("plain text untouched", () => {
    expect(Renderer.cleanOutput("plain text")).toBe("plain text");
  });
});

describe("renderOutput", () => {
  test("empty becomes (no output)", () => {
    const render = new Renderer(() => ({ content: "   " }));

    expect(render.renderOutput("anything", null, 100, 10)).toBe("(no output)");
  });

  test("untruncated returns content", () => {
    const render = new Renderer((text) => ({ content: text, truncated: false }));

    expect(render.renderOutput("body", null, 100, 10)).toBe("body");
  });

  test("truncated includes header and spill path", () => {
    const render = new Renderer(() => ({ content: "tail", truncated: true, totalLines: 900, totalBytes: 5000 }));
    const out = render.renderOutput("ignored", "/log/j1.log", 100, 10);

    expect(out).toBe("[output truncated: showing the tail of 900 lines / 5000 bytes; full output: /log/j1.log]\ntail");
  });

  test("truncated without spill omits the path clause", () => {
    const render = new Renderer(() => ({ content: "tail", truncated: true, totalLines: 5, totalBytes: 9 }));
    const out = render.renderOutput("ignored", null, 100, 10);

    expect(out).toBe("[output truncated: showing the tail of 5 lines / 9 bytes]\ntail");
  });
});

describe("tailBody", () => {
  test("empty content uses the supplied fallback", () => {
    const render = new Renderer(() => ({ content: "" }));

    expect(render.tailBody("x", 10, 5, "(no output yet)")).toBe("(no output yet)");
  });

  test("non-empty content returned as-is", () => {
    const render = new Renderer((text) => ({ content: text }));

    expect(render.tailBody("hi", 10, 5, "(none)")).toBe("hi");
  });
});
