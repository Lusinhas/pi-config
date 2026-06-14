import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FsRead } from "./disk.ts";
import type { SkillsConfig } from "./config.ts";

export class Discovery {
  private readonly realPathCache = new Map<string, string>();

  constructor(
    private readonly fs: FsRead = new FsRead(),
    private readonly home: () => string = () => "",
  ) {}

  walkSkillDirs(baseDir: string): string[] {
    const results: string[] = [];

    if (!this.fs.isDirectory(baseDir)) {

      return results;
    }

    const stack: string[] = [baseDir];
    const visited = new Set<string>([this.cachedRealPath(baseDir)]);

    while (stack.length > 0) {
      const dir = stack.pop() as string;
      const entries = this.fs.readEntries(dir);

      if (this.containsSkillFile(dir, entries)) {
        results.push(dir);

        continue;
      }

      for (const entry of entries) {

        if (entry.name.startsWith(".") || entry.name === "node_modules") {

          continue;
        }

        const full = join(dir, entry.name);
        const isDir = entry.isDirectory() || (entry.isSymbolicLink() && this.fs.isDirectory(full));

        if (!isDir) {

          continue;
        }

        const real = this.cachedRealPath(full);

        if (visited.has(real)) {

          continue;
        }

        visited.add(real);
        stack.push(full);
      }
    }

    return results.sort();
  }

  private containsSkillFile(dir: string, entries: readonly Dirent[]): boolean {
    for (const entry of entries) {

      if (entry.name !== "SKILL.md") {

        continue;
      }

      if (entry.isFile()) {

        return true;
      }

      if (entry.isSymbolicLink() && this.fs.isFile(join(dir, "SKILL.md"))) {

        return true;
      }

      return false;
    }

    return false;
  }

  projectSkillBases(cwd: string): string[] {
    const bases: string[] = [];
    let dir = resolve(cwd);

    for (;;) {
      bases.push(join(dir, ".claude", "skills"));
      const parent = dirname(dir);

      if (existsSync(join(dir, ".git")) || parent === dir) {

        break;
      }

      dir = parent;
    }

    return bases;
  }

  expandHome(path: string): string {

    if (path === "~") {

      return this.home();
    }

    if (path.startsWith("~/")) {

      return join(this.home(), path.slice(2));
    }

    return path;
  }

  discoverClaudeSkills(cwd: string, trusted: boolean, config: SkillsConfig): string[] {
    const found = new Set<string>();

    if (config.global) {

      for (const dir of this.walkSkillDirs(join(this.home(), ".claude", "skills"))) {
        found.add(dir);
      }
    }

    if (config.project && trusted) {

      for (const base of this.projectSkillBases(cwd)) {

        for (const dir of this.walkSkillDirs(base)) {
          found.add(dir);
        }
      }
    }

    for (const extra of config.dirs) {

      for (const dir of this.walkSkillDirs(resolve(cwd, this.expandHome(extra)))) {
        found.add(dir);
      }
    }

    return [...found].sort();
  }

  private cachedRealPath(path: string): string {
    const cached = this.realPathCache.get(path);

    if (cached !== undefined) {

      return cached;
    }

    const real = this.fs.realPath(path);
    this.realPathCache.set(path, real);

    return real;
  }
}
