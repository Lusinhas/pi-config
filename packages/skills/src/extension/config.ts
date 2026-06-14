import { homedir } from "node:os";
import { join } from "node:path";
import { Config } from "../skills/config.ts";
import type { ConfigSources } from "../skills/config.ts";
import { FsRead } from "../skills/disk.ts";

export class ConfigLoader {
  constructor(
    private readonly fs: FsRead,
    private readonly shippedConfigUrl: URL,
  ) {}

  load(cwd: string, trusted: boolean): Config {
    const sources: ConfigSources = {
      shipped: this.fs.readJson(this.shippedConfigUrl),
      global: this.fs.readJson(this.globalPath()),
      project: trusted ? this.fs.readJson(this.projectPath(cwd)) : null,
    };

    return new Config(sources);
  }

  fingerprint(cwd: string, trusted: boolean): string {
    const shipped = this.fs.mtimeMs(this.shippedConfigUrl);
    const global = this.fs.mtimeMs(this.globalPath());
    const project = trusted ? this.fs.mtimeMs(this.projectPath(cwd)) : 0;

    return `${shipped}:${global}:${project}`;
  }

  private globalPath(): string {
    return join(homedir(), ".pi", "agent", "suite.json");
  }

  private projectPath(cwd: string): string {
    return join(cwd, ".pi", "suite.json");
  }
}
