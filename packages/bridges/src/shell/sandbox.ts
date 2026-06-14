import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { SandboxNetwork, SandboxSettings } from "./config.ts";

export interface WrittenProfile {
  path: string;
  cleanup: () => void;
}

export interface EscapeOutcome {
  command: string;
  bypass: boolean;
}

export interface SandboxPlan {
  argv: string[];
  sandboxed: boolean;
  wrapper: "bwrap" | "sandboxexec" | "none";
  note: string;
  cleanup: () => void;
}

export interface ExecResultLike {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
}

export type ExecFn = (cmd: string, args: string[], options?: { timeout?: number }) => Promise<ExecResultLike>;

const ESCAPE_PREFIX = /^\s*unsandboxed:\s*/;

const PROBE_TIMEOUT_MS = 5000;

export class Profile {
  static escapeProfilePath(path: string): string {
    return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  static buildProfile(writable: string[], network: SandboxNetwork): string {
    const lines: string[] = ["(version 1)", "(allow default)", "(deny file-write*)"];
    const unique = [...new Set(writable)].filter((path) => path.startsWith("/"));

    for (const path of unique) {
      lines.push(`(allow file-write* (subpath "${Profile.escapeProfilePath(path)}"))`);
    }

    lines.push('(allow file-write* (literal "/dev/null"))');
    lines.push('(allow file-write* (literal "/dev/dtracehelper"))');
    lines.push('(allow file-write-data (regex #"^/dev/tty"))');

    if (network === "none") {
      lines.push("(deny network*)");
    }

    return `${lines.join("\n")}\n`;
  }

  static writeProfile(writable: string[], network: SandboxNetwork): WrittenProfile {
    const dir = mkdtempSync(join(tmpdir(), "pisandbox"));
    const path = join(dir, "profile.sb");
    writeFileSync(path, Profile.buildProfile(writable, network), { mode: 0o600 });
    let removed = false;

    return {
      path,
      cleanup: (): void => {
        if (removed) {
          return;
        }

        removed = true;

        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          removed = true;
        }
      },
    };
  }
}

export class Sandbox {
  private probePromise: Promise<boolean> | null = null;
  private rtkPromise: Promise<boolean> | null = null;

  constructor(private readonly exec: ExecFn) {}

  rtkAvailable(): Promise<boolean> {
    if (this.rtkPromise === null) {
      this.rtkPromise = this.exec("rtk", ["--version"], { timeout: PROBE_TIMEOUT_MS })
        .then((result) => result.code === 0)
        .catch(() => false);
    }

    return this.rtkPromise;
  }

  splitEscape(command: string, escapeAllowed: boolean): EscapeOutcome {
    const match = ESCAPE_PREFIX.exec(command);

    if (match === null) {
      return { command, bypass: false };
    }

    if (!escapeAllowed) {
      throw new Error(
        'The "unsandboxed:" escape prefix is disabled (shell config sandbox.escape is false). Run the command without the prefix, or enable sandbox.escape in suite.json.',
      );
    }

    const stripped = command.slice(match[0].length);

    if (stripped.trim() === "") {
      throw new Error('No command given after the "unsandboxed:" prefix.');
    }

    return { command: stripped, bypass: true };
  }

  wrapperAvailable(): Promise<boolean> {
    if (this.probePromise === null) {
      this.probePromise = this.probe().catch(() => false);
    }

    return this.probePromise;
  }

  private async probe(): Promise<boolean> {
    if (process.platform === "linux") {
      const result = await this.exec("bwrap", ["--version"], { timeout: PROBE_TIMEOUT_MS });

      return result.code === 0;
    }

    if (process.platform === "darwin") {
      const result = await this.exec("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
        timeout: PROBE_TIMEOUT_MS,
      });

      return result.code === 0;
    }

    return false;
  }

  static expandPath(path: string): string {
    const trimmed = path.trim();

    if (trimmed === "~") {
      return homedir();
    }

    if (trimmed.startsWith("~/")) {
      return resolve(homedir(), trimmed.slice(2));
    }

    return resolve(trimmed);
  }

  static withinTmp(path: string): boolean {
    return path === "/tmp" || path.startsWith(`/tmp${sep}`);
  }

  static collectWritable(cwdAbs: string, settings: SandboxSettings): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    const push = (raw: string): void => {
      if (typeof raw !== "string" || raw.trim() === "") {
        return;
      }

      const expanded = Sandbox.expandPath(raw);

      if (seen.has(expanded)) {
        return;
      }

      seen.add(expanded);

      if (!existsSync(expanded)) {
        return;
      }

      out.push(expanded);
    };

    push(cwdAbs);
    push(tmpdir());

    for (const path of settings.writePaths) {
      push(path);
    }

    return out;
  }

  static readonly rtkTools = new Set<string>([
    "ls", "tree", "git", "gh", "glab", "aws", "psql", "pnpm", "find", "diff",
    "dotnet", "docker", "kubectl", "grep", "wget", "wc", "jest", "vitest", "prisma",
    "tsc", "next", "prettier", "playwright", "cargo", "npm", "npx", "curl", "ruff",
    "pytest", "mypy", "rake", "rubocop", "rspec", "pip", "go", "gt", "golangci-lint",
    "gradlew", "mvn",
  ]);

  static rtkWrappable(command: string): boolean {
    const trimmed = command.trim();

    if (trimmed === "") {
      return false;
    }

    if (/[|&;<>(){}`$\\\n]/.test(trimmed)) {
      return false;
    }

    return Sandbox.rtkTools.has(trimmed.split(/\s+/)[0]);
  }

  static shellArgv(shell: string, command: string, rtk = false): string[] {
    if (process.platform === "win32" && basename(shell).toLowerCase().startsWith("cmd")) {
      return [shell, "/d", "/s", "/c", command];
    }

    const inner = rtk && Sandbox.rtkWrappable(command) ? `rtk ${command}` : command;

    return [shell, "-c", inner];
  }

  private static plainPlan(argv: string[], note: string): SandboxPlan {
    return { argv, sandboxed: false, wrapper: "none", note, cleanup: () => void 0 };
  }

  private static buildLinux(inner: string[], cwdAbs: string, settings: SandboxSettings): SandboxPlan {
    const argv = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];

    if (settings.mode === "strict") {
      argv.push("--tmpfs", "/tmp");
    }

    for (const path of Sandbox.collectWritable(cwdAbs, settings)) {
      if (settings.mode === "strict" && Sandbox.withinTmp(path) && path !== cwdAbs) {
        continue;
      }

      argv.push("--bind", path, path);
    }

    if (settings.network === "none") {
      argv.push("--unshare-net");
    } else {
      argv.push("--share-net");
    }

    argv.push("--die-with-parent", "--chdir", cwdAbs, "--", ...inner);

    return {
      argv,
      sandboxed: true,
      wrapper: "bwrap",
      note: `sandboxed (${settings.mode}, network ${settings.network})`,
      cleanup: () => void 0,
    };
  }

  private static buildDarwin(inner: string[], cwdAbs: string, settings: SandboxSettings): SandboxPlan {
    const writable = Sandbox.collectWritable(cwdAbs, settings);
    const profile = Profile.writeProfile(writable, settings.network);

    return {
      argv: ["/usr/bin/sandbox-exec", "-f", profile.path, ...inner],
      sandboxed: true,
      wrapper: "sandboxexec",
      note: `sandboxed (${settings.mode}, network ${settings.network})`,
      cleanup: profile.cleanup,
    };
  }

  buildPlan(shell: string, command: string, cwd: string, settings: SandboxSettings, available: boolean, rtk = false): SandboxPlan {
    const inner = Sandbox.shellArgv(shell, command, rtk);
    const active = settings.enabled && settings.mode !== "off";

    if (!active) {
      return Sandbox.plainPlan(inner, "");
    }

    if (process.platform !== "linux" && process.platform !== "darwin") {
      return Sandbox.plainPlan(
        inner,
        `sandbox mode "${settings.mode}" requested but unsupported on ${process.platform}; running unsandboxed`,
      );
    }

    if (!available) {
      const tool = process.platform === "linux" ? "bwrap" : "sandbox-exec";

      return Sandbox.plainPlan(
        inner,
        `sandbox mode "${settings.mode}" requested but ${tool} is unavailable; running unsandboxed`,
      );
    }

    const cwdAbs = resolve(cwd);

    if (process.platform === "linux") {
      return Sandbox.buildLinux(inner, cwdAbs, settings);
    }

    return Sandbox.buildDarwin(inner, cwdAbs, settings);
  }
}
