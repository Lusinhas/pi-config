import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSettings } from "../../src/shell/config.ts";
import { type ExecFn, type ExecResultLike, Profile, Sandbox } from "../../src/shell/sandbox.ts";

function settings(overrides: Partial<SandboxSettings>): SandboxSettings {
  return { enabled: true, mode: "loose", network: "full", writePaths: [], escape: true, ...overrides };
}

function execFor(code: number | null): ExecFn {
  return async (): Promise<ExecResultLike> => ({ stdout: "", stderr: "", code, killed: false });
}

describe("splitEscape", () => {
  const sandbox = new Sandbox(execFor(0));

  test("no prefix passes through unchanged", () => {
    expect(sandbox.splitEscape("ls -la", true)).toEqual({ command: "ls -la", bypass: false });
  });

  test("prefix with escape allowed strips and bypasses", () => {
    expect(sandbox.splitEscape("unsandboxed: echo hi", true)).toEqual({ command: "echo hi", bypass: true });
  });

  test("leading whitespace before prefix is honored", () => {
    expect(sandbox.splitEscape("  unsandboxed:  pwd", true)).toEqual({ command: "pwd", bypass: true });
  });

  test("prefix with escape disabled throws the exact message", () => {
    expect(() => sandbox.splitEscape("unsandboxed: ls", false)).toThrow(
      'The "unsandboxed:" escape prefix is disabled (shell config sandbox.escape is false). Run the command without the prefix, or enable sandbox.escape in suite.json.',
    );
  });

  test("empty remainder throws the exact message", () => {
    expect(() => sandbox.splitEscape("unsandboxed:   ", true)).toThrow(
      'No command given after the "unsandboxed:" prefix.',
    );
  });
});

describe("wrapperAvailable", () => {
  test("probes once and reuses the promise", async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls += 1;

      return { stdout: "", stderr: "", code: 0, killed: false };
    };
    const sandbox = new Sandbox(exec);
    const a = await sandbox.wrapperAvailable();
    const b = await sandbox.wrapperAvailable();

    if (process.platform === "linux" || process.platform === "darwin") {
      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(calls).toBe(1);
    } else {
      expect(a).toBe(false);
      expect(calls).toBe(0);
    }
  });

  test("exec rejection resolves to false", async () => {
    const exec: ExecFn = async () => {
      throw new Error("missing");
    };
    const sandbox = new Sandbox(exec);

    expect(await sandbox.wrapperAvailable()).toBe(false);
  });

  test("fresh instances re-probe independently", async () => {
    const failing = new Sandbox(async () => ({ stdout: "", stderr: "", code: 1, killed: false }));
    const ok = new Sandbox(execFor(0));
    const failingResult = await failing.wrapperAvailable();
    const okResult = await ok.wrapperAvailable();

    if (process.platform === "linux" || process.platform === "darwin") {
      expect(failingResult).toBe(false);
      expect(okResult).toBe(true);
    } else {
      expect(failingResult).toBe(false);
      expect(okResult).toBe(false);
    }
  });
});

describe("shellArgv", () => {
  test("posix shells use -c", () => {
    expect(Sandbox.shellArgv("/bin/bash", "echo hi")).toEqual(["/bin/bash", "-c", "echo hi"]);
  });

  test("rtk routes a supported command to its subcommand", () => {
    expect(Sandbox.shellArgv("/bin/bash", "git status", true)).toEqual(["/bin/bash", "-c", "rtk git status"]);
    expect(Sandbox.shellArgv("/bin/bash", "ls -la", true)).toEqual(["/bin/bash", "-c", "rtk ls -la"]);
  });

  test("rtk leaves unknown commands, pipelines, and substitutions unwrapped", () => {
    expect(Sandbox.shellArgv("/bin/bash", "cd /tmp", true)).toEqual(["/bin/bash", "-c", "cd /tmp"]);
    expect(Sandbox.shellArgv("/bin/bash", "ls | wc -l", true)).toEqual(["/bin/bash", "-c", "ls | wc -l"]);
    expect(Sandbox.shellArgv("/bin/bash", "echo $HOME", true)).toEqual(["/bin/bash", "-c", "echo $HOME"]);
  });

  test("rtk disabled never wraps", () => {
    expect(Sandbox.shellArgv("/bin/bash", "git status")).toEqual(["/bin/bash", "-c", "git status"]);
  });
});

describe("rtkWrappable", () => {
  test("accepts commands rtk has a dedicated wrapper for", () => {
    expect(Sandbox.rtkWrappable("cargo test")).toBe(true);
    expect(Sandbox.rtkWrappable("git log --oneline")).toBe(true);
    expect(Sandbox.rtkWrappable("pytest -q")).toBe(true);
    expect(Sandbox.rtkWrappable("docker ps")).toBe(true);
    expect(Sandbox.rtkWrappable("golangci-lint run")).toBe(true);
  });

  test("rejects unknown commands, paths, operators, assignments, and empties", () => {
    expect(Sandbox.rtkWrappable("someunknowncmd --x")).toBe(false);
    expect(Sandbox.rtkWrappable("cd /tmp")).toBe(false);
    expect(Sandbox.rtkWrappable("/usr/bin/git status")).toBe(false);
    expect(Sandbox.rtkWrappable("git log | head")).toBe(false);
    expect(Sandbox.rtkWrappable("cargo build && cargo test")).toBe(false);
    expect(Sandbox.rtkWrappable("ls > out.txt")).toBe(false);
    expect(Sandbox.rtkWrappable("FOO=1 cargo build")).toBe(false);
    expect(Sandbox.rtkWrappable("   ")).toBe(false);
  });
});

describe("expandPath", () => {
  test("tilde alone expands to home", () => {
    expect(Sandbox.expandPath("~")).toBe(homedir());
  });

  test("tilde slash expands under home", () => {
    const expanded = Sandbox.expandPath("~/sub");

    expect(expanded.endsWith("/sub")).toBe(true);
  });

  test("relative path resolves to absolute", () => {
    expect(Sandbox.expandPath("foo").startsWith("/")).toBe(true);
  });
});

describe("withinTmp", () => {
  test("matches /tmp and descendants only", () => {
    expect(Sandbox.withinTmp("/tmp")).toBe(true);
    expect(Sandbox.withinTmp("/tmp/x")).toBe(true);
    expect(Sandbox.withinTmp("/tmpfoo")).toBe(false);
    expect(Sandbox.withinTmp("/home")).toBe(false);
  });
});

describe("collectWritable", () => {
  test("orders cwd, tmpdir, then writePaths and dedups existing paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "collect"));
    const result = Sandbox.collectWritable(dir, settings({ writePaths: [dir, "/does/not/exist/xyz"] }));

    expect(result[0]).toBe(dir);
    expect(result).toContain(tmpdir());
    expect(result.filter((p) => p === dir).length).toBe(1);
    expect(result).not.toContain("/does/not/exist/xyz");
  });

  test("drops non-existent paths", () => {
    const result = Sandbox.collectWritable("/no/such/cwd/here", settings({ writePaths: [] }));

    expect(result).not.toContain("/no/such/cwd/here");
    expect(result).toContain(tmpdir());
  });
});

describe("buildPlan", () => {
  const sandbox = new Sandbox(execFor(0));

  test("inactive sandbox returns plain plan with empty note", () => {
    const plan = sandbox.buildPlan("/bin/bash", "echo hi", "/tmp", settings({ enabled: false }), true);

    expect(plan.sandboxed).toBe(false);
    expect(plan.note).toBe("");
    expect(plan.argv).toEqual(["/bin/bash", "-c", "echo hi"]);
  });

  test("mode off returns plain plan even when enabled", () => {
    const plan = sandbox.buildPlan("/bin/bash", "x", "/tmp", settings({ mode: "off" }), true);

    expect(plan.sandboxed).toBe(false);
    expect(plan.note).toBe("");
  });

  test("unavailable wrapper yields plain plan with diagnostic note", () => {
    const plan = sandbox.buildPlan("/bin/bash", "x", "/tmp", settings({}), false);

    expect(plan.sandboxed).toBe(false);

    if (process.platform === "linux") {
      expect(plan.note).toContain("bwrap is unavailable");
    } else if (process.platform === "darwin") {
      expect(plan.note).toContain("sandbox-exec is unavailable");
    } else {
      expect(plan.note).toContain("unsupported on");
    }
  });

  test("linux loose plan binds writable, shares net, chdir, inner at end", () => {
    if (process.platform !== "linux") {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "plan"));
    const plan = sandbox.buildPlan("/bin/bash", "echo hi", dir, settings({}), true);

    expect(plan.sandboxed).toBe(true);
    expect(plan.wrapper).toBe("bwrap");
    expect(plan.argv.slice(0, 8)).toEqual(["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]);
    expect(plan.argv).toContain("--share-net");
    expect(plan.argv).toContain("--die-with-parent");
    expect(plan.argv).toContain("--chdir");
    expect(plan.argv.slice(-3)).toEqual(["/bin/bash", "-c", "echo hi"]);
    expect(plan.note).toBe("sandboxed (loose, network full)");
  });

  test("linux strict adds tmpfs and skips within-tmp non-cwd binds", () => {
    if (process.platform !== "linux") {
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "strict"));
    const plan = sandbox.buildPlan(
      "/bin/bash",
      "echo hi",
      dir,
      settings({ mode: "strict", network: "none" }),
      true,
    );
    const tmpfsAt = plan.argv.indexOf("--tmpfs");

    expect(tmpfsAt).toBeGreaterThan(-1);
    expect(plan.argv[tmpfsAt + 1]).toBe("/tmp");
    expect(plan.argv).toContain("--unshare-net");
    expect(plan.argv).toContain(dir);
    expect(plan.note).toBe("sandboxed (strict, network none)");
  });
});

describe("Profile.buildProfile", () => {
  test("emits header, deny, writable subpaths and dev literals", () => {
    const text = Profile.buildProfile(["/work", "relative"], "full");

    expect(text.startsWith("(version 1)\n(allow default)\n(deny file-write*)\n")).toBe(true);
    expect(text).toContain('(allow file-write* (subpath "/work"))');
    expect(text).not.toContain("relative");
    expect(text).toContain('(allow file-write* (literal "/dev/null"))');
    expect(text).toContain('(allow file-write* (literal "/dev/dtracehelper"))');
    expect(text).toContain('(allow file-write-data (regex #"^/dev/tty"))');
    expect(text.endsWith("\n")).toBe(true);
  });

  test("network none adds deny network*", () => {
    expect(Profile.buildProfile(["/w"], "none")).toContain("(deny network*)");
    expect(Profile.buildProfile(["/w"], "full")).not.toContain("(deny network*)");
  });

  test("escapeProfilePath escapes backslashes and quotes", () => {
    expect(Profile.escapeProfilePath('a\\b"c')).toBe('a\\\\b\\"c');
  });

  test("writeProfile creates a readable file and cleanup removes it", () => {
    const written = Profile.writeProfile(["/w"], "full");

    expect(written.path.endsWith("profile.sb")).toBe(true);
    written.cleanup();
    written.cleanup();
  });
});
