import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export class PathResolver {
  static expandHome(value: string): string {
    if (value === "~") {
      return homedir();
    }

    if (value.startsWith("~/")) {
      return join(homedir(), value.slice(2));
    }

    return value;
  }

  static absolute(value: string, cwd: string): string {
    const expanded = PathResolver.expandHome(value);

    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  }

  static candidates(toolName: string, argument: string, cwd: string, pathTools: readonly string[]): string[] {
    const candidates = new Set<string>();

    candidates.add(argument);

    if (argument.length > 0 && pathTools.includes(toolName) && !argument.includes("\n")) {
      const expanded = PathResolver.expandHome(argument);
      const absolute = PathResolver.absolute(argument, cwd);

      candidates.add(expanded);
      candidates.add(absolute);

      const relativePath = relative(cwd, absolute);

      if (relativePath.length > 0 && !relativePath.startsWith("..")) {
        candidates.add(relativePath);
      }

      candidates.add(basename(absolute));
    }

    return [...candidates];
  }
}
