import { describe, expect, test } from "bun:test";
import { Detector, Scanner, type ScanOptions } from "../../src/comments/patterns.ts";

const detector = new Detector();
const scanner = new Scanner(detector);

const options: ScanOptions = {
  allowMarker: "@allow-comment",
  detectors: { narration: true, fillerdoc: true, changemarker: true, todo: true, separator: true },
};

function scan(source: string, language: Parameters<Scanner["scanAdded"]>[2], opts: ScanOptions = options) {
  const lines = source.split("\n");
  const added = lines.map(() => true);
  return scanner.scanAdded(lines, added, language, opts);
}

describe("detectLanguage", () => {
  test("maps extensions", () => {
    expect(scanner.detectLanguage("/a/b.ts")).toBe("ts");
    expect(scanner.detectLanguage("/a/b.tsx")).toBe("ts");
    expect(scanner.detectLanguage("/a/b.py")).toBe("py");
    expect(scanner.detectLanguage("/a/b.rb")).toBe("rb");
    expect(scanner.detectLanguage("/a/b.json")).toBe("json");
    expect(scanner.detectLanguage("/a/b.md")).toBe("md");
    expect(scanner.detectLanguage("/a/README")).toBeNull();
  });

  test("shebang sniff only when content provided", () => {
    expect(scanner.detectLanguage("/a/script", "#!/usr/bin/env bash\n")).toBe("sh");
    expect(scanner.detectLanguage("/a/script", "#!/usr/bin/python3\n")).toBe("py");
    expect(scanner.detectLanguage("/a/script", "#!/usr/bin/env ruby\n")).toBe("rb");
    expect(scanner.detectLanguage("/a/script", "#!/usr/bin/env node\n")).toBe("js");
    expect(scanner.detectLanguage("/a/script")).toBeNull();
  });
});

describe("separator detector", () => {
  test("flags decorative separators", () => {
    const findings = scan("// ======\nconst x = 1;", "ts");
    expect(findings.map((f) => f.rule)).toEqual(["separator"]);
    expect(findings[0].line).toBe(1);
  });

  test("short separators are ignored", () => {
    expect(scan("// --", "ts")).toEqual([]);
  });

  test("more than two distinct chars is not a separator", () => {
    expect(scan("// -=~+", "ts")).toEqual([]);
  });
});

describe("change-marker detector", () => {
  test("flags bare change markers", () => {
    expect(scan("// added\nlet a = 1;", "ts").map((f) => f.rule)).toEqual(["changemarker"]);
    expect(scan("// now uses cache\nlet a = 1;", "ts").map((f) => f.rule)).toEqual(["changemarker"]);
  });
});

describe("loose todo detector", () => {
  test("bare TODO flagged", () => {
    expect(scan("// TODO clean up\nx();", "ts").map((f) => f.rule)).toEqual(["todo"]);
  });

  test("TODO with issue ref is allowed", () => {
    expect(scan("// TODO(#123) fix later\nx();", "ts")).toEqual([]);
    expect(scan("// TODO ABC-12 ship it\nx();", "ts")).toEqual([]);
    expect(scan("// TODO see https://x.y/issue\nx();", "ts")).toEqual([]);
    expect(scan("// TODO(alice) fix\nx();", "ts")).toEqual([]);
  });
});

describe("narration detector", () => {
  test("generic narration flagged", () => {
    expect(scan("// loops over the items\nfor (const i of items) {}", "ts").map((f) => f.rule)).toEqual(["narration"]);
  });

  test("reasoning words exempt narration", () => {
    expect(scan("// loops over items because order matters\nfor (const i of items) {}", "ts")).toEqual([]);
  });

  test("restating adjacent code flagged as narration", () => {
    const findings = scan("// increment counter\ncounter += 1;", "ts");
    expect(findings.map((f) => f.rule)).toEqual(["narration"]);
  });
});

describe("exemptions", () => {
  test("allow marker exempts a line", () => {
    expect(scan("// added @allow-comment\nx();", "ts")).toEqual([]);
  });

  test("why exempts", () => {
    expect(scan("// added because why not\nx();", "ts")).toEqual([]);
  });

  test("license words exempt", () => {
    expect(scan("// Copyright 2026 Acme; added\nx();", "ts")).toEqual([]);
  });

  test("linter directive exempt", () => {
    expect(scan("// eslint-disable-next-line\nx();", "ts")).toEqual([]);
    expect(scan("# type: ignore\nx = 1", "py")).toEqual([]);
  });

  test("jsdoc @-tag lines are skipped at the line level", () => {
    expect(scan("// @ts-ignore\nx();", "ts")).toEqual([]);
  });
});

describe("doc filler block", () => {
  test("filler doc block flagged at start line", () => {
    const src = "/**\n * The config options.\n */\nconst config = {};";
    const findings = scan(src, "ts");
    expect(findings.map((f) => f.rule)).toEqual(["fillerdoc"]);
    expect(findings[0].line).toBe(1);
  });

  test("a non-filler line clears the block", () => {
    const src = "/**\n * Explains why we retry three times before bailing out here.\n */\nconst config = {};";
    expect(scan(src, "ts")).toEqual([]);
  });

  test("single-line /**/ is not treated as a doc block", () => {
    expect(scan("/**/\nx();", "ts")).toEqual([]);
  });
});

describe("string handling", () => {
  test("comment markers inside strings are ignored", () => {
    expect(scan('const url = "http://x"; ', "ts")).toEqual([]);
    expect(scan('const s = "// not a comment";', "ts")).toEqual([]);
  });

  test("hash inside shell single-quote string ignored", () => {
    expect(scan("echo 'a # b'", "sh")).toEqual([]);
  });
});

describe("hash-style languages", () => {
  test("python narration flagged", () => {
    expect(scan("# loops over the rows\nfor row in rows:", "py").map((f) => f.rule)).toEqual(["narration"]);
  });
});

describe("scanAdded structural", () => {
  test("unsupported language returns []", () => {
    expect(scanner.scanAdded(["// x"], [true], null, options)).toEqual([]);
    expect(scanner.scanAdded(["// x"], [true], "json", options)).toEqual([]);
    expect(scanner.scanAdded(["// x"], [true], "md", options)).toEqual([]);
  });

  test("non-added comment lines ignored", () => {
    const lines = "// added\nx();".split("\n");
    expect(scanner.scanAdded(lines, [false, true], "ts", options)).toEqual([]);
  });

  test("findings sorted ascending by line", () => {
    const src = "// added\nlet a=1;\n// ======\nlet b=2;";
    const findings = scan(src, "ts");
    expect(findings.map((f) => f.line)).toEqual([1, 3]);
  });

  test("detector toggle disables a rule", () => {
    const off: ScanOptions = { ...options, detectors: { ...options.detectors, separator: false } };
    expect(scan("// ======\nx();", "ts", off)).toEqual([]);
  });
});
