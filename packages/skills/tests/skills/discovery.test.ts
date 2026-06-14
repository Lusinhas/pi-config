import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Discovery } from "../../src/skills/index.ts";
import { FsRead } from "../../src/skills/disk.ts";

class Tree {
  readonly root: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "skills-"));
  }

  dir(...parts: string[]): string {
    const path = join(this.root, ...parts);
    mkdirSync(path, { recursive: true });

    return path;
  }

  skill(...parts: string[]): string {
    const path = this.dir(...parts);
    writeFileSync(join(path, "SKILL.md"), "x");

    return path;
  }

  file(rel: string, body: string): string {
    const path = join(this.root, rel);
    writeFileSync(path, body);

    return path;
  }

  link(target: string, ...linkParts: string[]): string {
    const link = join(this.root, ...linkParts);
    symlinkSync(target, link);

    return link;
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

function discovery(home: string): Discovery {
  return new Discovery(new FsRead(), () => home);
}

describe("walkSkillDirs", () => {
  let tree: Tree;

  beforeEach(() => {
    tree = new Tree();
  });

  afterEach(() => {
    tree.cleanup();
  });

  test("missing base returns empty", () => {
    const d = discovery(tree.root);
    expect(d.walkSkillDirs(join(tree.root, "nope"))).toEqual([]);
  });

  test("base that is a file returns empty", () => {
    const file = tree.file("plain.txt", "hi");
    const d = discovery(tree.root);
    expect(d.walkSkillDirs(file)).toEqual([]);
  });

  test("matches SKILL.md directly in base dir", () => {
    const base = tree.skill("base");
    const d = discovery(tree.root);
    expect(d.walkSkillDirs(base)).toEqual([base]);
  });

  test("finds nested skill dirs sorted", () => {
    const base = tree.dir("base");
    const beta = tree.skill("base", "beta");
    const alpha = tree.skill("base", "alpha");
    const d = discovery(tree.root);
    expect(d.walkSkillDirs(base)).toEqual([alpha, beta].sort());
  });

  test("does not descend into a skill dir once SKILL.md found", () => {
    const outer = tree.skill("base", "outer");
    tree.skill("base", "outer", "inner");
    const d = discovery(tree.root);
    expect(d.walkSkillDirs(join(tree.root, "base"))).toEqual([outer]);
  });

  test("skips dotdirs and node_modules", () => {
    const base = tree.dir("base");
    tree.skill("base", ".hidden");
    tree.skill("base", "node_modules");
    const kept = tree.skill("base", "real");
    const d = discovery(tree.root);
    expect(d.walkSkillDirs(base)).toEqual([kept]);
  });

  test("follows symlinked directories", () => {
    const target = tree.skill("targets", "linked");
    const base = tree.dir("base");
    tree.link(target, "base", "viasym");
    const d = discovery(tree.root);
    const out = d.walkSkillDirs(base);
    expect(out).toContain(join(base, "viasym"));
  });

  test("SKILL.md that is a directory does not count", () => {
    const base = tree.dir("base", "candidate");
    mkdirSync(join(base, "SKILL.md"));
    const d = discovery(tree.root);
    expect(d.walkSkillDirs(join(tree.root, "base"))).toEqual([]);
  });

  test("symlink cycle is bounded and terminates", () => {
    const base = tree.dir("base");
    const sub = tree.dir("base", "sub");
    tree.link(base, "base", "sub", "loop");
    const skill = tree.skill("base", "sub", "leaf");
    const d = discovery(tree.root);
    const out = d.walkSkillDirs(base);
    expect(out).toContain(skill);
    expect(Array.isArray(out)).toBe(true);
  });
});

describe("projectSkillBases", () => {
  let tree: Tree;

  beforeEach(() => {
    tree = new Tree();
  });

  afterEach(() => {
    tree.cleanup();
  });

  test("walks up to and including the dir containing .git", () => {
    const repo = tree.dir("repo");
    tree.file("repo/.git", "gitdir: ../somewhere");
    const nested = tree.dir("repo", "a", "b");
    const d = discovery(tree.root);
    const bases = d.projectSkillBases(nested);
    expect(bases[0]).toBe(join(nested, ".claude", "skills"));
    expect(bases[bases.length - 1]).toBe(join(repo, ".claude", "skills"));
    expect(bases).toContain(join(repo, "a", ".claude", "skills"));
    expect(bases).not.toContain(join(tree.root, ".claude", "skills"));
  });

  test("git as a directory is also a boundary", () => {
    const repo = tree.dir("repo");
    tree.dir("repo", ".git");
    const d = discovery(tree.root);
    const bases = d.projectSkillBases(repo);
    expect(bases).toEqual([join(repo, ".claude", "skills")]);
  });

  test("walks to filesystem root when no .git found", () => {
    const nested = tree.dir("plain", "deep");
    const d = discovery(tree.root);
    const bases = d.projectSkillBases(nested);
    expect(bases[0]).toBe(join(nested, ".claude", "skills"));
    const last = bases[bases.length - 1];
    expect(last).toBe(join(resolve("/"), ".claude", "skills"));
  });
});

describe("expandHome", () => {
  test("bare tilde maps to home", () => {
    const d = discovery("/fake/home");
    expect(d.expandHome("~")).toBe("/fake/home");
  });

  test("tilde slash joins under home", () => {
    const d = discovery("/fake/home");
    expect(d.expandHome("~/skills")).toBe(join("/fake/home", "skills"));
  });

  test("other paths unchanged", () => {
    const d = discovery("/fake/home");
    expect(d.expandHome("/abs/path")).toBe("/abs/path");
    expect(d.expandHome("rel/path")).toBe("rel/path");
    expect(d.expandHome("~tilde")).toBe("~tilde");
  });
});

describe("discoverClaudeSkills", () => {
  let tree: Tree;

  beforeEach(() => {
    tree = new Tree();
  });

  afterEach(() => {
    tree.cleanup();
  });

  test("global source picks up ~/.claude/skills", () => {
    const home = tree.dir("home");
    const skill = tree.skill("home", ".claude", "skills", "writer");
    const d = discovery(home);
    const out = d.discoverClaudeSkills(tree.dir("work"), false, {
      global: true,
      project: true,
      dirs: [],
    });
    expect(out).toEqual([skill]);
  });

  test("global disabled skips ~/.claude/skills", () => {
    const home = tree.dir("home");
    tree.skill("home", ".claude", "skills", "writer");
    const d = discovery(home);
    const out = d.discoverClaudeSkills(tree.dir("work"), false, {
      global: false,
      project: true,
      dirs: [],
    });
    expect(out).toEqual([]);
  });

  test("project source requires trusted", () => {
    const home = tree.dir("home");
    const work = tree.dir("work");
    const projectSkill = tree.skill("work", ".claude", "skills", "proj");
    tree.file("work/.git", "x");
    const d = discovery(home);

    const untrusted = d.discoverClaudeSkills(work, false, {
      global: false,
      project: true,
      dirs: [],
    });
    expect(untrusted).toEqual([]);

    const trusted = d.discoverClaudeSkills(work, true, {
      global: false,
      project: true,
      dirs: [],
    });
    expect(trusted).toEqual([projectSkill]);
  });

  test("project disabled skips project skills even when trusted", () => {
    const home = tree.dir("home");
    const work = tree.dir("work");
    tree.skill("work", ".claude", "skills", "proj");
    tree.file("work/.git", "x");
    const d = discovery(home);
    const out = d.discoverClaudeSkills(work, true, {
      global: false,
      project: false,
      dirs: [],
    });
    expect(out).toEqual([]);
  });

  test("extra dirs are home-expanded then resolved against cwd", () => {
    const home = tree.dir("home");
    const work = tree.dir("work");
    const homeSkill = tree.skill("home", "extra", "fromhome");
    const relSkill = tree.skill("work", "local", "fromrel");
    const d = discovery(home);
    const out = d.discoverClaudeSkills(work, false, {
      global: false,
      project: false,
      dirs: ["~/extra", "local"],
    });
    expect(out).toEqual([homeSkill, relSkill].sort());
  });

  test("absolute extra dir passes through resolve unchanged", () => {
    const home = tree.dir("home");
    const work = tree.dir("work");
    const abs = tree.skill("absolute", "here");
    const d = discovery(home);
    const out = d.discoverClaudeSkills(work, false, {
      global: false,
      project: false,
      dirs: [join(tree.root, "absolute")],
    });
    expect(out).toEqual([abs]);
  });

  test("result deduplicates across sources and stays globally sorted", () => {
    const home = tree.dir("home");
    const work = tree.dir("work");
    const shared = tree.skill("home", ".claude", "skills", "shared");
    const d = discovery(home);
    const out = d.discoverClaudeSkills(work, false, {
      global: true,
      project: false,
      dirs: [join(home, ".claude", "skills")],
    });
    expect(out).toEqual([shared]);
  });

  test("combined sources sorted ascending", () => {
    const home = tree.dir("home");
    const work = tree.dir("work");
    tree.file("work/.git", "x");
    const g = tree.skill("home", ".claude", "skills", "zglobal");
    const p = tree.skill("work", ".claude", "skills", "aproject");
    const d = discovery(home);
    const out = d.discoverClaudeSkills(work, true, {
      global: true,
      project: true,
      dirs: [],
    });
    expect(out).toEqual([g, p].sort());
    expect([...out]).toEqual([...out].sort());
  });
});
