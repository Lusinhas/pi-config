import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AuthConfig } from "../extension/config.ts";
import type { ClaudeCodeCreds } from "../credentials/store.ts";
import { CredentialStore } from "../credentials/store.ts";
import { CredentialRefresher } from "../credentials/refresh.ts";
import { ModelCatalog } from "../models/catalog.ts";
import { AnthropicStream } from "../stream/anthropic.ts";

const PROVIDER_ID = "claude-code";
const PROVIDER_NAME = "Claude Code (OAuth)";

export class ProviderRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly catalog: ModelCatalog;
  private readonly store: CredentialStore;
  private readonly refresher: CredentialRefresher;
  private readonly stream: AnthropicStream;
  private readonly config: AuthConfig;

  constructor(
    pi: ExtensionAPI,
    catalog: ModelCatalog,
    store: CredentialStore,
    refresher: CredentialRefresher,
    stream: AnthropicStream,
    config: AuthConfig,
  ) {
    this.pi = pi;
    this.catalog = catalog;
    this.store = store;
    this.refresher = refresher;
    this.stream = stream;
    this.config = config;
  }

  register(): void {
    this.pi.registerProvider(PROVIDER_ID, {
      name: PROVIDER_NAME,
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      models: this.catalog.models(),
      oauth: {
        name: PROVIDER_NAME,
        login: (callbacks) => this.login(callbacks),
        refreshToken: (credentials) => this.refreshToken(credentials),
        getApiKey: (cred) => cred.access,
      },
      streamSimple: this.stream.streamSimple,
    });
  }

  private async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const existing = this.store.read();

    if (existing) {
      const fresh = await this.refresher.refresh(existing);

      return this.toCredentials(fresh);
    }

    await callbacks.onPrompt({
      message:
        "No Claude Code credentials found. Run `claude` once to log in, then re-run `/login claude-code`. Press Enter to abort.",
    });

    throw new Error("Claude Code credentials not found. Run `claude` to authenticate first.");
  }

  private async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const fresh = await this.refresher.refresh({
      accessToken: credentials.access,
      refreshToken: credentials.refresh,
      expiresAt: credentials.expires,
    });

    return this.toCredentials(fresh);
  }

  private toCredentials(creds: ClaudeCodeCreds): OAuthCredentials {
    return {
      access: creds.accessToken,
      refresh: creds.refreshToken,
      expires: creds.expiresAt,
    };
  }
}
