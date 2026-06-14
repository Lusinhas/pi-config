import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loaders } from "./config.ts";
import { PermissionsRegistrar } from "./permissions.ts";
import { CheckpointRegistrar } from "./checkpoint.ts";

export class GuardExtension {
  constructor(private readonly pi: ExtensionAPI) {}

  register(): void {
    const config = Loaders.load();

    new PermissionsRegistrar(this.pi, config.permissions).register();
    new CheckpointRegistrar(this.pi, config.checkpoint).register();
  }
}
