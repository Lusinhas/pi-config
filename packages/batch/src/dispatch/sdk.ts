import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type CoreToolName, type CoreToolProvider, type ExecutableTool } from "./dispatch.ts";

export class SdkCoreTools implements CoreToolProvider {
  private readonly cache = new Map<string, ExecutableTool>();

  build(name: CoreToolName, cwd: string): ExecutableTool {
    const key = `${name}\u0000${cwd}`;
    const existing = this.cache.get(key);

    if (existing) {
      return existing;
    }

    const tool = SdkCoreTools.create(name, cwd);
    this.cache.set(key, tool);

    return tool;
  }

  private static create(name: CoreToolName, cwd: string): ExecutableTool {
    switch (name) {
      case "read":
        return createReadToolDefinition(cwd) as unknown as ExecutableTool;
      case "write":
        return createWriteToolDefinition(cwd) as unknown as ExecutableTool;
      case "edit":
        return createEditToolDefinition(cwd) as unknown as ExecutableTool;
      case "grep":
        return createGrepToolDefinition(cwd) as unknown as ExecutableTool;
      case "find":
        return createFindToolDefinition(cwd) as unknown as ExecutableTool;
      case "ls":
        return createLsToolDefinition(cwd) as unknown as ExecutableTool;
      case "bash":
        return createBashToolDefinition(cwd) as unknown as ExecutableTool;
    }
  }
}
