import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { BashParser } from "../../src/permissions/parsing.ts";
import { PathResolver } from "../../src/permissions/path.ts";
import { RuleEngine, type EngineConfig } from "../../src/permissions/index.ts";
import { RuleSanitizer, RuleText, isRecord, type SessionRule } from "../../src/permissions/text.ts";

const baseConfig = (overrides: Partial<EngineConfig> = {}): EngineConfig => ({
  mode: "ask",
  allow: [],
  deny: [],
  ask: [],
  readTools: ["read", "grep", "ls"],
  writeTools: ["write", "edit", "bash"],
  bashTools: ["bash"],
  pathTools: ["read", "write", "edit", "ls"],
  ...overrides,
});

const engine = (overrides: Partial<EngineConfig> = {}, sessionRules: SessionRule[] = []) =>
  new RuleEngine(baseConfig(overrides), sessionRules);

describe("isRecord", () => {
  test("accepts plain objects and rejects arrays/null/primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(3)).toBe(false);
  });
});

describe("RuleSanitizer", () => {
  test("rules drops invalid entries and trims tool", () => {
    const result = RuleSanitizer.rules([
      { tool: "  bash  ", pattern: " ls " },
      { tool: "" },
      { pattern: "x" },
      "nope",
      { tool: "read" },
    ]);

    expect(result).toEqual([{ tool: "bash", pattern: " ls " }, { tool: "read" }]);
  });

  test("rules returns empty for non-array", () => {
    expect(RuleSanitizer.rules(undefined)).toEqual([]);
    expect(RuleSanitizer.rules({})).toEqual([]);
    expect(RuleSanitizer.rules("x")).toEqual([]);
  });

  test("sessionRule keeps prefix and ignores blank pattern", () => {
    expect(RuleSanitizer.sessionRule({ tool: "bash", pattern: "git", prefix: true })).toEqual({
      tool: "bash",
      pattern: "git",
      prefix: true,
    });
    expect(RuleSanitizer.sessionRule({ tool: "bash", pattern: "   " })).toEqual({ tool: "bash" });
    expect(RuleSanitizer.sessionRule({ tool: "bash", prefix: false })).toEqual({ tool: "bash" });
    expect(RuleSanitizer.sessionRule({})).toBeUndefined();
    expect(RuleSanitizer.sessionRule(null)).toBeUndefined();
  });
});

describe("RuleText", () => {
  test("format renders tool, pattern, prefix", () => {
    expect(RuleText.format({ tool: "bash" })).toBe("tool=bash");
    expect(RuleText.format({ tool: "bash", pattern: "git" })).toBe('tool=bash pattern="git"');
    expect(RuleText.format({ tool: "bash", pattern: "git", prefix: true })).toBe('tool=bash pattern="git" (prefix)');
  });

  test("safeStringify never throws on circular or bigint input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(RuleText.safeStringify(circular)).toBe(String(circular));
    expect(RuleText.safeStringify(10n)).toBe("10");
    expect(RuleText.safeStringify({ a: 1 })).toBe('{"a":1}');
  });
});

describe("RuleEngine.normalizeArgument", () => {
  test("nullish becomes empty string", () => {
    expect(engine().normalizeArgument("read", undefined)).toBe("");
    expect(engine().normalizeArgument("read", null)).toBe("");
  });

  test("string passes through", () => {
    expect(engine().normalizeArgument("read", "literal")).toBe("literal");
  });

  test("bash tool uses command field or safeStringify", () => {
    expect(engine().normalizeArgument("bash", { command: "ls -la" })).toBe("ls -la");
    expect(engine().normalizeArgument("bash", { other: 1 })).toBe('{"other":1}');
  });

  test("path tool uses first present path key", () => {
    expect(engine().normalizeArgument("read", { file_path: "a.ts" })).toBe("a.ts");
    expect(engine().normalizeArgument("read", { directory: "src" })).toBe("src");
    expect(engine().normalizeArgument("read", { path: "p", file_path: "f" })).toBe("p");
  });

  test("path tool with no path key falls back to safeStringify", () => {
    expect(engine().normalizeArgument("read", { mode: 1 })).toBe('{"mode":1}');
  });

  test("non-record non-string uses safeStringify and never throws", () => {
    expect(engine().normalizeArgument("read", 42)).toBe("42");
    expect(engine().normalizeArgument("read", 7n)).toBe("7");
  });
});

describe("PathResolver", () => {
  test("expandHome resolves tilde forms", () => {
    expect(PathResolver.expandHome("~")).toBe(homedir());
    expect(PathResolver.expandHome("~/x")).toBe(`${homedir()}/x`);
    expect(PathResolver.expandHome("plain")).toBe("plain");
  });

  test("candidates for path tool include abs, relative, basename", () => {
    const result = PathResolver.candidates("read", "src/a.ts", "/repo", ["read"]);

    expect(result).toContain("src/a.ts");
    expect(result).toContain("/repo/src/a.ts");
    expect(result).toContain("a.ts");
  });

  test("candidates omits relative when escaping cwd", () => {
    const result = PathResolver.candidates("read", "/etc/passwd", "/repo", ["read"]);

    expect(result).toContain("/etc/passwd");
    expect(result.some((c) => c.startsWith(".."))).toBe(false);
  });

  test("candidates for non-path tool only include the raw argument", () => {
    expect(PathResolver.candidates("bash", "ls", "/repo", ["read"])).toEqual(["ls"]);
  });

  test("candidates skips expansion when argument has a newline", () => {
    expect(PathResolver.candidates("read", "a\nb", "/repo", ["read"])).toEqual(["a\nb"]);
  });
});

describe("RuleEngine.matchPattern", () => {
  test("wildcard star matches within a path segment", () => {
    expect(engine().matchPattern("*.ts", ["a.ts"])).toBe(true);
    expect(engine().matchPattern("*.ts", ["a/b.ts"])).toBe(false);
  });

  test("double star spans separators", () => {
    expect(engine().matchPattern("src/**", ["src/a/b.ts"])).toBe(true);
  });

  test("question mark matches a single non-slash char", () => {
    expect(engine().matchPattern("a?c", ["abc"])).toBe(true);
    expect(engine().matchPattern("a?c", ["a/c"])).toBe(false);
  });

  test("non-wildcard pattern is substring match", () => {
    expect(engine().matchPattern("passwd", ["/etc/passwd"])).toBe(true);
    expect(engine().matchPattern("passwd", ["/etc/shadow"])).toBe(false);
  });

  test("regex cache stays bounded and reuses entries", () => {
    const e = engine();

    expect(e.matchPattern("*.ts", ["a.ts"])).toBe(true);
    expect(e.matchPattern("*.ts", ["b.ts"])).toBe(true);
    expect(e.cacheSize).toBe(1);

    for (let i = 0; i < 600; i += 1) {
      e.matchPattern(`p${i}*`, ["x"]);
    }

    expect(e.cacheSize).toBeLessThanOrEqual(512);
  });
});

describe("RuleEngine.matchesRule", () => {
  test("star tool matches any", () => {
    expect(engine().matchesRule({ tool: "*" }, "anything", ["x"])).toBe(true);
  });

  test("exact tool match", () => {
    expect(engine().matchesRule({ tool: "read" }, "read", ["x"])).toBe(true);
    expect(engine().matchesRule({ tool: "read" }, "write", ["x"])).toBe(false);
  });

  test("prefix rule matches exact or space-prefixed candidate", () => {
    const rule: SessionRule = { tool: "bash", pattern: "git", prefix: true };

    expect(engine().matchesRule(rule, "bash", ["git"])).toBe(true);
    expect(engine().matchesRule(rule, "bash", ["git status"])).toBe(true);
    expect(engine().matchesRule(rule, "bash", ["github"])).toBe(false);
  });

  test("rule with no pattern matches the tool unconditionally", () => {
    expect(engine().matchesRule({ tool: "read" }, "read", [])).toBe(true);
  });
});

describe("BashParser", () => {
  test("splits on operators outside quotes", () => {
    expect(BashParser.split("ls; cat a | grep x && echo y")).toEqual(["ls", "cat a", "grep x", "echo y"]);
  });

  test("does not split inside quotes", () => {
    expect(BashParser.split("echo 'a; b' && ls")).toEqual(["echo 'a; b'", "ls"]);
    expect(BashParser.split('echo "a | b"')).toEqual(['echo "a | b"']);
  });

  test("handles escapes and newlines", () => {
    expect(BashParser.split("a \\; b")).toEqual(["a \\; b"]);
    expect(BashParser.split("a\nb")).toEqual(["a", "b"]);
  });

  test("empty command yields trimmed single segment", () => {
    expect(BashParser.split("   ")).toEqual([""]);
  });

  test("program skips VAR= prefixes", () => {
    expect(BashParser.program("FOO=1 BAR=2 git status")).toBe("git");
    expect(BashParser.program("ls -la")).toBe("ls");
    expect(BashParser.program("FOO=1")).toBe("FOO=1");
    expect(BashParser.program("")).toBe("");
  });
});

describe("RuleEngine.approvalRules", () => {
  test("bash rules per distinct program", () => {
    const rules = engine().approvalRules("bash", ["git status", "git push", "ls -la"], "/repo");

    expect(rules).toEqual([
      { tool: "bash", pattern: "git", prefix: true },
      { tool: "bash", pattern: "ls", prefix: true },
    ]);
  });

  test("bash with no program falls back to tool-only rule", () => {
    expect(engine().approvalRules("bash", [""], "/repo")).toEqual([{ tool: "bash" }]);
  });

  test("path rule covers parent directory glob", () => {
    expect(engine().approvalRules("read", ["/repo/src/a.ts"], "/repo")).toEqual([
      { tool: "read", pattern: "/repo/src/**" },
    ]);
  });

  test("path rule at root uses /**", () => {
    expect(engine().approvalRules("read", ["/a.ts"], "/repo")).toEqual([{ tool: "read", pattern: "/**" }]);
  });

  test("path rule with empty or newline argument falls back", () => {
    expect(engine().approvalRules("read", [""], "/repo")).toEqual([{ tool: "read" }]);
    expect(engine().approvalRules("read", ["a\nb"], "/repo")).toEqual([{ tool: "read" }]);
  });

  test("other tools get tool-only rule", () => {
    expect(engine().approvalRules("grep", ["x"], "/repo")).toEqual([{ tool: "grep" }]);
  });
});

describe("RuleEngine.evaluate precedence", () => {
  test("deny beats allow beats session beats mode default", () => {
    const e = engine(
      { allow: [{ tool: "read" }], deny: [{ tool: "read", pattern: "secret" }] },
      [{ tool: "write", pattern: "ok" }],
    );

    expect(e.evaluate("read", { path: "secret.txt" }, "/repo")).toEqual({
      action: "deny",
      reason: 'deny rule tool=read pattern="secret"',
      units: ["secret.txt"],
    });

    const allowed = e.evaluate("read", { path: "fine.txt" }, "/repo");

    expect(allowed.action).toBe("allow");
    expect(allowed.reason).toBe("allow rule tool=read");
  });

  test("session approval reason applies outside ask mode", () => {
    const e = engine({ mode: "auto" }, [{ tool: "edit", pattern: "src/**" }]);
    const result = e.evaluate("edit", { path: "/repo/src/a.ts" }, "/repo");

    expect(result.action).toBe("allow");
    expect(result.reason).toBe('session approval tool=edit pattern="src/**"');
  });

  test("session rules are ignored in ask mode and fall through to the mode default", () => {
    const e = engine({ mode: "ask" }, [{ tool: "edit", pattern: "src/**" }]);
    const result = e.evaluate("edit", { path: "/repo/src/a.ts" }, "/repo");

    expect(result.action).toBe("ask");
    expect(result.reason).toBe("ask mode default for edit");
  });

  test("yolo allows everything not denied", () => {
    const e = engine({ mode: "yolo" });

    expect(e.evaluate("edit", { path: "a.ts" }, "/repo").reason).toBe("yolo mode allows everything not denied");
  });

  test("ask rule before mode default", () => {
    const e = engine({ ask: [{ tool: "read" }] });
    const result = e.evaluate("read", { path: "a.ts" }, "/repo");

    expect(result.action).toBe("ask");
    expect(result.reason).toBe("ask rule tool=read");
  });

  test("mode default reason for tool", () => {
    const e = engine({ mode: "ask" });

    expect(e.evaluate("edit", { path: "a.ts" }, "/repo").reason).toBe("ask mode default for edit");
  });
});

describe("RuleEngine.evaluate bash", () => {
  test("deny matches the full pipeline command first", () => {
    const e = engine({ deny: [{ tool: "bash", pattern: "rm -rf" }] });
    const result = e.evaluate("bash", { command: "echo hi && rm -rf now" }, "/repo");

    expect(result.action).toBe("deny");
    expect(result.reason).toBe('deny rule tool=bash pattern="rm -rf"');
    expect(result.units).toEqual(["echo hi && rm -rf now"]);
  });

  test("deny matches a single segment with segment context", () => {
    const e = engine({ deny: [{ tool: "bash", pattern: "curl*" }] });
    const result = e.evaluate("bash", { command: "ls && curl evil.com" }, "/repo");

    expect(result.action).toBe("deny");
    expect(result.reason).toBe('deny rule tool=bash pattern="curl*" on segment "curl evil.com"');
    expect(result.units).toEqual(["curl evil.com"]);
  });

  test("all segments allowed yields multi-segment reason", () => {
    const e = engine({ allow: [{ tool: "bash" }] });
    const result = e.evaluate("bash", { command: "ls && pwd" }, "/repo");

    expect(result.action).toBe("allow");
    expect(result.reason).toBe("all command segments allowed");
    expect(result.units).toEqual(["ls", "pwd"]);
  });

  test("single segment allowed yields command allowed", () => {
    const e = engine({ allow: [{ tool: "bash" }] });

    expect(e.evaluate("bash", { command: "ls" }, "/repo").reason).toBe("command allowed");
  });

  test("pending ask keeps first ask reason and collects segments", () => {
    const e = engine({ allow: [{ tool: "bash", pattern: "ls", prefix: true }], mode: "ask" });
    const result = e.evaluate("bash", { command: "ls && rm x && rmdir y" }, "/repo");

    expect(result.action).toBe("ask");
    expect(result.reason).toBe("ask mode default for bash");
    expect(result.units).toEqual(["rm x", "rmdir y"]);
  });
});
