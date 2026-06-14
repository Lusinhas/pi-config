import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Config } from "../router/index.ts";
import { LoaderRegistrar } from "./loader.ts";
import { RouterRegistrar } from "./router.ts";

export interface SuiteSources {
  shipped: unknown;
  global: unknown;
  project: unknown;
}

export class CoreConfig {
  static readonly SHIPPED_URL = new URL("../../config.json", import.meta.url);

  load(cwd: string): SuiteSources {
    const shipped = Config.readJson(CoreConfig.SHIPPED_URL);
    const global = Config.readJson(join(homedir(), ".pi", "agent", "suite.json"));
    const project = Config.readJson(join(cwd, ".pi", "suite.json"));

    return { shipped, global, project };
  }
}

export class CoreExtension {
  #pi: ExtensionAPI;
  #config: CoreConfig;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
    this.#config = new CoreConfig();
  }

  register(): void {
    new LoaderRegistrar(this.#pi).register();
    new RouterRegistrar(this.#pi, this.#config).register();
  }
}
