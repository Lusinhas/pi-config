import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigLoader } from "./config.ts";
import { BillingHeader } from "../signing/billing.ts";
import { ModelCatalog } from "../models/catalog.ts";
import { ClaudeCodeTransform } from "../transforms/reshape.ts";
import { CredentialStore } from "../credentials/store.ts";
import { CredentialRefresher } from "../credentials/refresh.ts";
import { AnthropicStream } from "../stream/anthropic.ts";
import { ProviderRegistrar } from "../provider/registrar.ts";

export class AuthExtension {
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  register(): void {
    const config = new ConfigLoader(process.cwd()).load();

    if (!config.enabled) {
      return;
    }

    const catalog = new ModelCatalog();
    const billing = new BillingHeader();
    const transform = new ClaudeCodeTransform(catalog, billing);
    const store = new CredentialStore();
    const refresher = new CredentialRefresher(store);
    const stream = new AnthropicStream(catalog, transform, config.longContext);

    new ProviderRegistrar(this.pi, catalog, store, refresher, stream, config).register();
  }
}
