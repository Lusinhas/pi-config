import { describe, expect, test } from "bun:test";
import { Config } from "../../src/comments/config.ts";
import { Checker } from "../../src/comments/index.ts";
import { Detector, Scanner } from "../../src/comments/patterns.ts";

const config = new Config(Config.hardDefaults()).defaultConfig();

function makeChecker() {
  return new Checker(new Scanner(new Detector()));
}

const cwd = "/repo";

describe("runCheck path + tool gating", () => {
  test("non write/edit tool returns null", () => {
    expect(makeChecker().runCheck("bash", { path: "/repo/a.ts", content: "// added\nx();" }, cwd, config)).toBeNull();
  });

  test("non-record input returns null", () => {
    expect(makeChecker().runCheck("write", "nope", cwd, config)).toBeNull();
  });

  test("missing/blank path returns null", () => {
    expect(makeChecker().runCheck("write", { content: "// added\nx();" }, cwd, config)).toBeNull();
    expect(makeChecker().runCheck("write", { path: "   ", content: "// added\nx();" }, cwd, config)).toBeNull();
  });

  test("first path key wins", () => {
    const result = makeChecker().runCheck("write", { path: "a.ts", content: "// added\nx();" }, cwd, config);
    expect(result?.path).toBe("/repo/a.ts");
  });
});

describe("runCheck write content", () => {
  test("flags a write with slop comment", () => {
    const result = makeChecker().runCheck("write", { path: "/repo/a.ts", content: "// added\nx();" }, cwd, config);
    expect(result).not.toBeNull();
    expect(result?.tool).toBe("write");
    expect(result?.findings[0].rule).toBe("changemarker");
  });

  test("empty content returns null", () => {
    expect(makeChecker().runCheck("write", { path: "/repo/a.ts", content: "" }, cwd, config)).toBeNull();
  });

  test("generated file head is skipped", () => {
    const gen = "// @generated do not edit\n// added\nx();";
    expect(makeChecker().runCheck("write", { path: "/repo/a.ts", content: gen }, cwd, config)).toBeNull();
  });

  test("clean content returns null", () => {
    expect(makeChecker().runCheck("write", { path: "/repo/a.ts", content: "const x = 1;\n" }, cwd, config)).toBeNull();
  });
});

describe("runCheck edit newText/oldText", () => {
  test("only added lines are scanned", () => {
    const input = { path: "/repo/a.ts", old_string: "x();", new_string: "x();\n// added\ny();" };
    const result = makeChecker().runCheck("edit", input, cwd, config);
    expect(result).not.toBeNull();
    expect(result?.findings).toHaveLength(1);
    expect(result?.findings[0].rule).toBe("changemarker");
  });

  test("lines present in oldText are not treated as added", () => {
    const input = { path: "/repo/a.ts", old_string: "// added\nx();", new_string: "// added\nx();\ny();" };
    expect(makeChecker().runCheck("edit", input, cwd, config)).toBeNull();
  });

  test("missing newText returns null", () => {
    expect(makeChecker().runCheck("edit", { path: "/repo/a.ts", old_string: "x();" }, cwd, config)).toBeNull();
  });

  test("oldText defaults to empty so all lines added", () => {
    const result = makeChecker().runCheck("edit", { path: "/repo/a.ts", new_string: "// added\nx();" }, cwd, config);
    expect(result?.findings).toHaveLength(1);
  });
});

describe("language gating in runCheck", () => {
  test("json and md skipped", () => {
    expect(makeChecker().runCheck("write", { path: "/repo/a.json", content: "// added\nx();" }, cwd, config)).toBeNull();
    expect(makeChecker().runCheck("write", { path: "/repo/a.md", content: "// added\nx();" }, cwd, config)).toBeNull();
  });

  test("unknown extension skipped", () => {
    expect(makeChecker().runCheck("write", { path: "/repo/a.txt", content: "// added\nx();" }, cwd, config)).toBeNull();
  });
});

describe("matchesIgnore", () => {
  test("node_modules ignored", () => {
    const checker = makeChecker();
    expect(checker.matchesIgnore("/repo/node_modules/x/a.ts", cwd, config.ignore)).toBe(true);
  });

  test("min.js ignored by basename", () => {
    const checker = makeChecker();
    expect(checker.matchesIgnore("/repo/app.min.js", cwd, config.ignore)).toBe(true);
  });

  test("regular source not ignored", () => {
    const checker = makeChecker();
    expect(checker.matchesIgnore("/repo/src/a.ts", cwd, config.ignore)).toBe(false);
  });

  test("ignored file produces null from runCheck", () => {
    const input = { path: "/repo/dist/a.ts", content: "// added\nx();" };
    expect(makeChecker().runCheck("write", input, cwd, config)).toBeNull();
  });

  test("bad glob is skipped not thrown", () => {
    const checker = makeChecker();
    expect(checker.matchesIgnore("/repo/a.ts", cwd, ["[unterminated"])).toBe(false);
  });

  test("blank patterns skipped", () => {
    const checker = makeChecker();
    expect(checker.matchesIgnore("/repo/a.ts", cwd, ["   ", ""])).toBe(false);
  });
});

describe("diffAdded multiset known limitation", () => {
  test("identical moved lines may be mis-attributed", () => {
    const input = { path: "/repo/a.ts", old_string: "// added\n// added", new_string: "// added\n// added\n// added" };
    const result = makeChecker().runCheck("edit", input, cwd, config);
    expect(result?.findings).toHaveLength(1);
  });
});

describe("glob cache ownership", () => {
  test("repeated matches reuse the compiled regex deterministically", () => {
    const checker = makeChecker();
    const first = checker.matchesIgnore("/repo/node_modules/a.ts", cwd, config.ignore);
    const second = checker.matchesIgnore("/repo/node_modules/b.ts", cwd, config.ignore);
    expect(first).toBe(true);
    expect(second).toBe(true);
  });
});
