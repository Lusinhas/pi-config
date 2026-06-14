import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigLoader } from "./config.ts";
import { LifecycleHub, subagentDepth } from "./lifecycle.ts";
import { ShellRegistrar } from "./shell.ts";
import { WebRegistrar } from "./web.ts";
import { McpRegistrar } from "./mcp.ts";
import { IdeRegistrar } from "./ide.ts";
import { WorktreesRegistrar } from "./worktrees.ts";
import { HooksRegistrar } from "./hooks.ts";
import { ArtifactsRegistrar } from "./artifacts.ts";

export class BridgesExtension {
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  register(): void {
    const config = new ConfigLoader(process.cwd()).load();
    const hub = new LifecycleHub(this.pi);
    const depth = subagentDepth();

    new ShellRegistrar(this.pi, config.shell, hub).register();
    new WebRegistrar(this.pi, config.web, hub).register();
    new McpRegistrar(this.pi, config.mcp, hub).register();
    new WorktreesRegistrar(this.pi, config.worktrees, hub).register();
    new HooksRegistrar(this.pi, config.hooks, hub).register();
    new ArtifactsRegistrar(this.pi, config.artifacts, hub).register();

    if (depth === 0) {
      new IdeRegistrar(this.pi, config.ide, hub).register();
    }
  }
}
