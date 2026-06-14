import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigLoader } from "./config.ts";
import { HashlineRegistrar } from "./lines.ts";
import { AstgrepRegistrar } from "./syntax.ts";
import { CommentsRegistrar } from "./comments.ts";

export class EditingExtension {
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  register(): void {
    const config = new ConfigLoader(process.cwd()).load();

    new HashlineRegistrar(this.pi, config.hashline).register();
    new AstgrepRegistrar(this.pi, config.astgrep).register();
    new CommentsRegistrar(this.pi, config.comments).register();
  }
}
