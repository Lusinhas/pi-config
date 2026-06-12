import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { type SandboxNetwork, writeProfile } from "./profiles";

export type SandboxMode = "off" | "loose" | "strict";

export interface SandboxSettings {
  enabled: boolean;
  mode: SandboxMode;
  network: SandboxNetwork;
  writePaths: string[];
  escape: boolean;
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

export function splitEscape(command: string, escapeAllowed: boolean): EscapeOutcome {
  const match = ESCAPE_PREFIX.exec(command);
  if (match === null) return { command, bypass: false };
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

let wrapperProbe: Promise<boolean> | null = null;

async function probe(exec: ExecFn): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const result = await exec("bwrap", ["--version"], { timeout: 5000 });
      return result.code === 0;
    } catch {
      return false;
    }
  }
  if (process.platform === "darwin") {
    try {
      const result = await exec("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
        timeout: 5000,
      });
      return result.code === 0;
    } catch {
      return false;
    }
  }
  return false;
}

export function wrapperAvailable(exec: ExecFn): Promise<boolean> {
  if (wrapperProbe === null) {
    wrapperProbe = probe(exec).catch(() => false);
  }
  return wrapperProbe;
}

function expandPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function withinTmp(path: string): boolean {
  return path === "/tmp" || path.startsWith(`/tmp${sep}`);
}

function collectWritable(cwdAbs: string, settings: SandboxSettings): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    if (typeof raw !== "string" || raw.trim() === "") return;
    const expanded = expandPath(raw);
    if (seen.has(expanded)) return;
    seen.add(expanded);
    if (!existsSync(expanded)) return;
    out.push(expanded);
  };
  push(cwdAbs);
  push(tmpdir());
  for (const path of settings.writePaths) push(path);
  return out;
}

export function shellArgv(shell: string, command: string): string[] {
  if (process.platform === "win32" && basename(shell).toLowerCase().startsWith("cmd")) {
    return [shell, "/d", "/s", "/c", command];
  }
  return [shell, "-c", command];
}

function plainPlan(argv: string[], note: string): SandboxPlan {
  return { argv, sandboxed: false, wrapper: "none", note, cleanup: () => void 0 };
}

export function buildPlan(
  shell: string,
  command: string,
  cwd: string,
  settings: SandboxSettings,
  available: boolean,
): SandboxPlan {
  const inner = shellArgv(shell, command);
  const active = settings.enabled && settings.mode !== "off";
  if (!active) return plainPlan(inner, "");
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return plainPlan(inner, `sandbox mode "${settings.mode}" requested but unsupported on ${process.platform}; running unsandboxed`);
  }
  if (!available) {
    const tool = process.platform === "linux" ? "bwrap" : "sandbox-exec";
    return plainPlan(inner, `sandbox mode "${settings.mode}" requested but ${tool} is unavailable; running unsandboxed`);
  }
  const cwdAbs = resolve(cwd);
  const writable = collectWritable(cwdAbs, settings);
  if (process.platform === "linux") {
    const argv = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
    if (settings.mode === "strict") argv.push("--tmpfs", "/tmp");
    for (const path of writable) {
      if (settings.mode === "strict" && withinTmp(path) && path !== cwdAbs) continue;
      argv.push("--bind", path, path);
    }
    if (settings.network === "none") argv.push("--unshare-net");
    else argv.push("--share-net");
    argv.push("--die-with-parent", "--chdir", cwdAbs, "--", ...inner);
    return {
      argv,
      sandboxed: true,
      wrapper: "bwrap",
      note: `sandboxed (${settings.mode}, network ${settings.network})`,
      cleanup: () => void 0,
    };
  }
  const profile = writeProfile(writable, settings.network);
  return {
    argv: ["/usr/bin/sandbox-exec", "-f", profile.path, ...inner],
    sandboxed: true,
    wrapper: "sandboxexec",
    note: `sandboxed (${settings.mode}, network ${settings.network})`,
    cleanup: profile.cleanup,
  };
}
