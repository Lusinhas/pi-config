import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ClaudeCodeCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface CredentialBlob {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

export class CredentialStore {
  private readonly filePath: string;

  constructor(filePath: string = join(homedir(), ".claude", ".credentials.json")) {
    this.filePath = filePath;
  }

  read(): ClaudeCodeCreds | null {
    return this.readFromKeychain() ?? this.readFromFile();
  }

  parse(raw: string): ClaudeCodeCreds | null {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const data =
      (parsed as { claudeAiOauth?: CredentialBlob }).claudeAiOauth ?? (parsed as CredentialBlob);

    const access = data.accessToken ?? data.access_token;
    const refresh = data.refreshToken ?? data.refresh_token;
    const expires = data.expiresAt ?? data.expires_at;

    if (!access || !refresh || typeof expires !== "number") {
      return null;
    }

    return { accessToken: access, refreshToken: refresh, expiresAt: expires };
  }

  writeBack(creds: ClaudeCodeCreds): void {
    const path = this.filePath;
    const dir = dirname(path);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    let existing: Record<string, unknown> = {};

    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }

    const updated = {
      ...existing,
      claudeAiOauth: {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
      },
    };

    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;

    try {
      writeFileSync(tmp, JSON.stringify(updated, null, 2), { encoding: "utf-8", mode: 0o600 });

      if (process.platform !== "win32") {
        chmodSync(tmp, 0o600);
      }

      renameSync(tmp, path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        void 0;
      }

      throw err;
    }
  }

  private readFromFile(): ClaudeCodeCreds | null {
    if (!existsSync(this.filePath)) {
      return null;
    }

    try {
      return this.parse(readFileSync(this.filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  private readFromKeychain(): ClaudeCodeCreds | null {
    if (process.platform !== "darwin") {
      return null;
    }

    const services = ["Claude Code-credentials"];

    try {
      const dump = execSync(
        'security dump-keychain 2>/dev/null | grep -o \'"Claude Code-credentials[^"]*"\'',
        { encoding: "utf-8", timeout: 5_000 },
      );
      const found = Array.from(
        new Set(
          dump
            .split("\n")
            .map((s) => s.replace(/"/g, "").trim())
            .filter(Boolean),
        ),
      );

      if (found.length > 0) {
        services.splice(0, services.length, ...found);
      }
    } catch (err) {
      if (CredentialStore.isExecTimeout(err)) {
        return null;
      }
    }

    for (const svc of services) {
      try {
        const out = execSync(`security find-generic-password -s ${JSON.stringify(svc)} -w`, {
          encoding: "utf-8",
          timeout: 5_000,
        }).trim();
        const creds = this.parse(out);

        if (creds) {
          return creds;
        }
      } catch (err) {
        if (CredentialStore.isExecTimeout(err)) {
          return null;
        }
      }
    }

    return null;
  }

  private static isExecTimeout(err: unknown): boolean {
    const e = err as { code?: string; signal?: string; name?: string };

    return e.code === "ETIMEDOUT" || e.signal === "SIGTERM" || e.name === "TimeoutError";
  }
}
