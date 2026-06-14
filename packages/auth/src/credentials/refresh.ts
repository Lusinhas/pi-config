import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { ClaudeCodeCreds } from "./store.ts";
import { CredentialStore } from "./store.ts";

export const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token";
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface OAuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
}

export class CredentialRefresher {
  private readonly store: CredentialStore;
  private inFlight: Promise<ClaudeCodeCreds> | null = null;

  constructor(store: CredentialStore) {
    this.store = store;
  }

  refresh(current: ClaudeCodeCreds): Promise<ClaudeCodeCreds> {
    if (current.expiresAt > Date.now() + 60_000) {
      return Promise.resolve(current);
    }

    return this.perform(current);
  }

  forceRefresh(current: ClaudeCodeCreds): Promise<ClaudeCodeCreds> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const onDisk = this.store.read();

    if (
      onDisk &&
      onDisk.refreshToken !== current.refreshToken &&
      onDisk.expiresAt > Date.now() + 60_000
    ) {
      return Promise.resolve(onDisk);
    }

    return this.perform(current);
  }

  private perform(current: ClaudeCodeCreds): Promise<ClaudeCodeCreds> {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = (async () => {
      try {
        let oauthError: unknown;
        const oauth = await this.refreshViaOAuth(current.refreshToken).catch((e) => {
          oauthError = e;
          return null;
        });

        if (oauth && oauth.expiresAt > Date.now() + 60_000) {
          try {
            this.store.writeBack(oauth);
          } catch {
            void 0;
          }

          return oauth;
        }

        const cliReason = this.refreshViaCli();
        const reread = this.store.read();

        if (reread && reread.expiresAt > Date.now() + 60_000) {
          return reread;
        }

        const reasons = [
          cliReason,
          oauthError ? `OAuth: ${CredentialRefresher.stringifyError(oauthError)}` : null,
        ].filter(Boolean);
        const suffix = reasons.length > 0 ? ` (${reasons.join("; ")})` : "";

        throw new Error(
          `Failed to refresh Claude Code credentials${suffix}. Run \`claude\` once to re-authenticate.`,
        );
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  private async refreshViaOAuth(refreshToken: string): Promise<ClaudeCodeCreds | null> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    });
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as OAuthResponse;

    if (!data.access_token) {
      return null;
    }

    const ttlSec = Number(data.expires_in);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : 36_000) * 1000,
    };
  }

  private refreshViaCli(): string | null {
    const cli = this.claudeCliPath();

    if (!cli) {
      return "claude CLI not found on PATH";
    }

    try {
      execSync(`${JSON.stringify(cli)} -p . --model haiku`, {
        timeout: 20_000,
        encoding: "utf-8",
        env: { ...process.env, TERM: "dumb" },
        stdio: ["ignore", "ignore", "pipe"],
        cwd: tmpdir(),
      });

      return null;
    } catch (err) {
      const e = err as { code?: string; signal?: string; stderr?: Buffer | string };

      if (e.signal === "SIGTERM") {
        return "claude CLI refresh timed out after 20s";
      }

      const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf-8") ?? "");
      const firstLine = stderr.split(/\r?\n/).find((l) => l.trim());

      return firstLine ? `claude CLI: ${firstLine}` : `claude CLI failed (${e.code ?? "unknown"})`;
    }
  }

  private claudeCliPath(): string | null {
    const probe = process.platform === "win32" ? "where claude" : "command -v claude";

    try {
      const out = execSync(probe, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
        .trim()
        .split(/\r?\n/)[0];

      return out || null;
    } catch {
      return null;
    }
  }

  private static stringifyError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);

    return message.length > 200 ? `${message.slice(0, 200)}...` : message;
  }
}
