import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigLoader } from "./config.ts";
import { EventBridge } from "./events.ts";
import { Discovery } from "../skills/index.ts";
import { FsRead } from "../skills/disk.ts";

export class SkillsExtension {
  private readonly bridge: EventBridge;

  constructor(private readonly pi: ExtensionAPI) {
    const fs = new FsRead();
    const discovery = new Discovery(fs, homedir);
    const configLoader = new ConfigLoader(fs, new URL("../../config.json", import.meta.url));
    this.bridge = new EventBridge(configLoader, discovery);
  }

  register(): void {
    this.pi.on("resources_discover", (event, ctx) => {

      return this.bridge.resourcesDiscover(event, ctx);
    });
  }
}
