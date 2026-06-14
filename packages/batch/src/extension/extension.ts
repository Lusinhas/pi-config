import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BatchRegistrar } from "./batch.ts";
import { Loader } from "./config.ts";

export class BatchExtension {
  constructor(private readonly pi: ExtensionAPI) {}

  register(): void {
    const config = Loader.load(new URL("../../config.json", import.meta.url), process.cwd());

    new BatchRegistrar(this.pi, config).register();
  }
}
