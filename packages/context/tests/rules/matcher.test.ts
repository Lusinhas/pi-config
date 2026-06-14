import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BashPaths, GlobMatcher, PathResolver, TouchTracker } from "../../src/rules/matcher.ts";

describe("GlobMatcher", () => {
  const matcher = new GlobMatcher();

  test("empty glob and empty path never match", () => {
    expect(matcher.match("", "a.ts")).toBe(false);
    expect(matcher.match("a.ts", "")).toBe(false);
  });

  test("single star stays within a segment", () => {
    expect(matcher.match("src/*.ts", "src/a.ts")).toBe(true);
    expect(matcher.match("src/*.ts", "src/sub/a.ts")).toBe(false);
  });

  test("question mark matches one non-slash char", () => {
    expect(matcher.match("a?.ts", "ab.ts")).toBe(true);
    expect(matcher.match("a?.ts", "a/.ts")).toBe(false);
  });

  test("double star spans directories", () => {
    expect(matcher.match("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
    expect(matcher.match("src/**", "src/anything/here.ts")).toBe(true);
  });

  test("brace alternation including nested", () => {
    expect(matcher.match("src/*.{ts,tsx}", "src/a.tsx")).toBe(true);
    expect(matcher.match("src/*.{ts,tsx}", "src/a.js")).toBe(false);
    expect(matcher.match("{a,{b,c}}/x.ts", "c/x.ts")).toBe(true);
  });

  test("bare filename glob is prefixed and matches any depth", () => {
    expect(matcher.match("README.md", "README.md")).toBe(true);
    expect(matcher.match("README.md", "docs/sub/README.md")).toBe(true);
    expect(matcher.match("README.md", "docs/readme.md")).toBe(false);
  });

  test("leading ./ and / on glob normalized", () => {
    expect(matcher.match("./src/a.ts", "src/a.ts")).toBe(true);
    expect(matcher.match("/src/a.ts", "src/a.ts")).toBe(true);
  });

  test("path normalization handles backslashes and double slashes", () => {
    expect(matcher.match("src/a.ts", "./src//a.ts")).toBe(true);
    expect(matcher.match("src/a.ts", "src\\a.ts")).toBe(true);
  });

  test("trailing slash glob becomes recursive", () => {
    expect(matcher.match("src/", "src/a/b.ts")).toBe(true);
  });

  test("invalid glob with only dots compiles to null and does not match", () => {
    expect(matcher.toRegExp("./.")).toBeNull();
    expect(matcher.match("./.", "a.ts")).toBe(false);
  });

  test("cache returns the same compiled regex instance", () => {
    const a = matcher.toRegExp("src/*.ts");
    const b = matcher.toRegExp("src/*.ts");

    expect(a).toBe(b);
  });
});

describe("PathResolver.toProjectRelative", () => {
  const resolver = new PathResolver();
  const root = "/project";

  test("resolves a relative path within the project", () => {
    expect(resolver.toProjectRelative("src/a.ts", root, root)).toBe("src/a.ts");
  });

  test("strips paired quotes", () => {
    expect(resolver.toProjectRelative('"src/a.ts"', root, root)).toBe("src/a.ts");
  });

  test("rejects empty, dot, and urls", () => {
    expect(resolver.toProjectRelative("", root, root)).toBeNull();
    expect(resolver.toProjectRelative(".", root, root)).toBeNull();
    expect(resolver.toProjectRelative("https://x.com/a", root, root)).toBeNull();
  });

  test("rejects paths escaping the project root", () => {
    expect(resolver.toProjectRelative("../outside.ts", root, root)).toBeNull();
    expect(resolver.toProjectRelative("/etc/passwd", root, root)).toBeNull();
  });

  test("resolves relative to baseCwd not project root", () => {
    expect(resolver.toProjectRelative("a.ts", root, "/project/sub")).toBe("sub/a.ts");
  });
});

describe("BashPaths.extract", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rules-bash-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "x");
    writeFileSync(join(dir, "readme.md"), "x");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("extracts existing path-like tokens", () => {
    const found = new BashPaths(new PathResolver()).extract("cat src/a.ts readme.md", dir, dir);

    expect(found.sort()).toEqual(["readme.md", "src/a.ts"]);
  });

  test("skips flags but keeps value after equals", () => {
    const found = new BashPaths(new PathResolver()).extract("grep --file=src/a.ts -n missing", dir, dir);

    expect(found).toEqual(["src/a.ts"]);
  });

  test("skips globs, vars, nonexistent, and git/node_modules", () => {
    mkdirSync(join(dir, "node_modules", "p"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "p", "x.ts"), "y");
    const found = new BashPaths(new PathResolver()).extract(
      "ls src/*.ts $HOME node_modules/p/x.ts ghost/none.ts",
      dir,
      dir,
    );

    expect(found).toEqual([]);
  });

  test("strips trailing line:col suffix", () => {
    const found = new BashPaths(new PathResolver()).extract("open src/a.ts:12:5", dir, dir);

    expect(found).toEqual(["src/a.ts"]);
  });

  test("token cap bounds the number of returned paths", () => {
    const parts: string[] = [];

    for (let i = 0; i < 40; i += 1) {
      const name = `f${i}.md`;
      writeFileSync(join(dir, name), "z");
      parts.push(name);
    }

    const found = new BashPaths(new PathResolver()).extract(`cat ${parts.join(" ")}`, dir, dir);

    expect(found.length).toBe(24);
  });
});

describe("TouchTracker", () => {
  const root = "/project";

  function tracker(): TouchTracker {
    const resolver = new PathResolver();

    return new TouchTracker(resolver, new BashPaths(resolver));
  }

  test("consume moves current to last and clears current", () => {
    const t = tracker();
    t.touch("src/a.ts", root, root);
    t.touch("src/b.ts", root, root);

    expect(t.pendingCount()).toBe(2);

    const consumed = t.consume().sort();

    expect(consumed).toEqual(["src/a.ts", "src/b.ts"]);
    expect(t.pendingCount()).toBe(0);
    expect(t.lastPaths().sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("reset clears both sets", () => {
    const t = tracker();
    t.touch("src/a.ts", root, root);
    t.consume();
    t.touch("src/b.ts", root, root);
    t.reset();

    expect(t.pendingCount()).toBe(0);
    expect(t.lastPaths()).toEqual([]);
  });

  test("touch ignores paths outside the project", () => {
    const t = tracker();
    t.touch("../escape.ts", root, root);

    expect(t.pendingCount()).toBe(0);
  });
});
