import { existsSync } from "node:fs";

export type SandboxMode = "off" | "loose" | "strict";

export type SandboxNetwork = "full" | "none";

export interface SandboxSettings {
  enabled: boolean;
  mode: SandboxMode;
  network: SandboxNetwork;
  writePaths: string[];
  escape: boolean;
}

export interface JobsSettings {
  autoBackgroundMs: number;
  capBytes: number;
  defaultWaitSec: number;
  keepFinished: number;
  notify: boolean;
}

export interface ShellConfig {
  shell: string;
  widget: boolean;
  widgetLimit: number;
  outputBytes: number;
  outputLines: number;
  sandbox: SandboxSettings;
  jobs: JobsSettings;
}

type Plain = Record<string, unknown>;

export const DEFAULTS: ShellConfig = {
  shell: "",
  widget: true,
  widgetLimit: 6,
  outputBytes: 24576,
  outputLines: 800,
  sandbox: { enabled: false, mode: "loose", network: "full", writePaths: [], escape: true },
  jobs: { autoBackgroundMs: 30000, capBytes: 2097152, defaultWaitSec: 30, keepFinished: 20, notify: true },
};

export function isRecord(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class Config {
  static readonly maxTimeoutSec = 86400;
  static readonly maxWaitSec = 600;
  static readonly toolPeekLines = 50;
  static readonly commandPeekLines = 15;

  private readonly effective: ShellConfig;

  constructor(shipped: unknown, overrides: ReadonlyArray<unknown>) {
    let merged: Plain = Config.clone(DEFAULTS);

    if (isRecord(shipped)) {
      merged = Config.deepMerge(merged, shipped);
    }

    for (const override of overrides) {
      if (isRecord(override)) {
        merged = Config.deepMerge(merged, override);
      }
    }

    this.effective = Config.sanitize(merged);
  }

  get value(): ShellConfig {
    return this.effective;
  }

  private static clone(value: ShellConfig): Plain {
    return JSON.parse(JSON.stringify(value)) as Plain;
  }

  static deepMerge(base: Plain, override: Plain): Plain {
    const out: Plain = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const current = out[key];
      out[key] = isRecord(current) && isRecord(value) ? Config.deepMerge(current, value) : value;
    }

    return out;
  }

  static posInt(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  static nonNegInt(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  }

  private static sanitizeSandbox(raw: Plain): SandboxSettings {
    const mode: SandboxMode =
      raw.mode === "off" || raw.mode === "loose" || raw.mode === "strict" ? raw.mode : DEFAULTS.sandbox.mode;
    const network: SandboxNetwork =
      raw.network === "full" || raw.network === "none" ? raw.network : DEFAULTS.sandbox.network;
    const writePaths = Array.isArray(raw.writePaths)
      ? raw.writePaths.filter((path): path is string => typeof path === "string" && path.trim() !== "")
      : DEFAULTS.sandbox.writePaths;

    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.sandbox.enabled,
      mode,
      network,
      writePaths,
      escape: typeof raw.escape === "boolean" ? raw.escape : DEFAULTS.sandbox.escape,
    };
  }

  private static sanitizeJobs(raw: Plain): JobsSettings {
    return {
      autoBackgroundMs: Config.nonNegInt(raw.autoBackgroundMs, DEFAULTS.jobs.autoBackgroundMs),
      capBytes: Config.posInt(raw.capBytes, DEFAULTS.jobs.capBytes),
      defaultWaitSec: Config.posInt(raw.defaultWaitSec, DEFAULTS.jobs.defaultWaitSec),
      keepFinished: Config.nonNegInt(raw.keepFinished, DEFAULTS.jobs.keepFinished),
      notify: typeof raw.notify === "boolean" ? raw.notify : DEFAULTS.jobs.notify,
    };
  }

  private static sanitize(merged: Plain): ShellConfig {
    const sandboxRaw = isRecord(merged.sandbox) ? merged.sandbox : {};
    const jobsRaw = isRecord(merged.jobs) ? merged.jobs : {};

    return {
      shell: typeof merged.shell === "string" ? merged.shell : DEFAULTS.shell,
      widget: typeof merged.widget === "boolean" ? merged.widget : DEFAULTS.widget,
      widgetLimit: Config.posInt(merged.widgetLimit, DEFAULTS.widgetLimit),
      outputBytes: Config.posInt(merged.outputBytes, DEFAULTS.outputBytes),
      outputLines: Config.posInt(merged.outputLines, DEFAULTS.outputLines),
      sandbox: Config.sanitizeSandbox(sandboxRaw),
      jobs: Config.sanitizeJobs(jobsRaw),
    };
  }

  static resolveShell(configured: string): string {
    const explicit = configured.trim();

    if (explicit !== "" && existsSync(explicit)) {
      return explicit;
    }

    if (process.platform === "win32") {
      return process.env.ComSpec ?? "cmd.exe";
    }

    for (const candidate of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"]) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    const env = (process.env.SHELL ?? "").trim();

    if (env !== "" && existsSync(env)) {
      return env;
    }

    return "/bin/sh";
  }
}
