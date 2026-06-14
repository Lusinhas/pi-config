import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SegmentState } from "../status/index.ts";
import { UsageTracker } from "../usage/index.ts";
import { Layers, subagentDepth, type InterfaceConfig } from "./config.ts";
import { ToolviewRegistrar } from "./view.ts";
import { UsageRegistrar } from "./usage.ts";
import { StatuslineRegistrar } from "./status.ts";
import { StylesRegistrar } from "./styles.ts";
import { AskRegistrar } from "./ask.ts";

export class InterfaceExtension {
  readonly #pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  register(): void {
    const pi = this.#pi;
    const config: InterfaceConfig = new Layers().load();
    const depth = subagentDepth();

    const segments = new SegmentState();
    const tracker = new UsageTracker();

    new ToolviewRegistrar(pi, config.toolview, depth).register();
    new UsageRegistrar(pi, config.usage, tracker, segments, depth).register();

    if (depth > 0) {
      return;
    }

    new StatuslineRegistrar(pi, config.statusline, segments).register();
    new StylesRegistrar(pi).register();
    new AskRegistrar(pi, config.ask).register();
  }
}
