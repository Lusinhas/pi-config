import { describe, expect, test } from "bun:test";
import { FrontmatterParser, StyleFileParser } from "../../src/styles/parse.ts";

const frontmatter = new FrontmatterParser();
const parser = new StyleFileParser(frontmatter);

describe("FrontmatterParser", () => {
  test("parses key:value pairs and body", () => {
    const result = frontmatter.parse("---\nname: foo\ndescription: bar\n---\nBody text\nline two");
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ name: "foo", description: "bar" });
    expect(result.body).toBe("Body text\nline two");
  });

  test("strips a leading BOM", () => {
    const result = frontmatter.parse("﻿---\nname: foo\n---\nbody");
    expect(result.error).toBeNull();
    expect(result.data.name).toBe("foo");
  });

  test("normalizes CRLF line endings", () => {
    const result = frontmatter.parse("---\r\nname: foo\r\n---\r\nbody here\r\n");
    expect(result.error).toBeNull();
    expect(result.data.name).toBe("foo");
    expect(result.body).toBe("body here");
  });

  test("missing opening delimiter", () => {
    const result = frontmatter.parse("name: foo\n---\nbody");
    expect(result.error).toBe("missing frontmatter opening delimiter");
  });

  test("empty input missing opening delimiter", () => {
    expect(frontmatter.parse("").error).toBe("missing frontmatter opening delimiter");
  });

  test("missing closing delimiter", () => {
    const result = frontmatter.parse("---\nname: foo\nno close here");
    expect(result.error).toBe("missing frontmatter closing delimiter");
  });

  test("skips blank and comment lines inside block", () => {
    const result = frontmatter.parse("---\n\n# a comment\nname: foo\n\n---\nbody");
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ name: "foo" });
  });

  test("invalid line with colon at index 0 reports 1-based number", () => {
    const result = frontmatter.parse("---\n:novalue\n---\nbody");
    expect(result.error).toBe('invalid frontmatter line 2: ":novalue"');
  });

  test("invalid line with no colon", () => {
    const result = frontmatter.parse("---\nname foo\n---\nbody");
    expect(result.error).toBe('invalid frontmatter line 2: "name foo"');
  });

  test("unquotes matched double and single quotes", () => {
    const result = frontmatter.parse('---\na: "quoted"\nb: \'single\'\nc: unq\n---\nbody');
    expect(result.data).toEqual({ a: "quoted", b: "single", c: "unq" });
  });

  test("leaves mismatched quotes intact", () => {
    const result = frontmatter.parse("---\na: \"mismatch'\n---\nbody");
    expect(result.data.a).toBe("\"mismatch'");
  });

  test("body is trimmed", () => {
    const result = frontmatter.parse("---\nname: foo\n---\n\n\n   body  \n\n");
    expect(result.body).toBe("body");
  });

  test("duplicate keys: last wins (preserved behavior)", () => {
    const result = frontmatter.parse("---\nname: first\nname: second\n---\nbody");
    expect(result.data.name).toBe("second");
  });

  test("value containing colons keeps everything after first colon", () => {
    const result = frontmatter.parse("---\ndescription: a: b: c\n---\nbody");
    expect(result.data.description).toBe("a: b: c");
  });
});

describe("StyleFileParser", () => {
  const valid = "---\nname: foo\ndescription: a style\n---\nThe body.";

  test("parses a valid style with source and path", () => {
    const result = parser.parse(valid, "/p/foo.md", "user");
    expect(result.error).toBeNull();
    expect(result.style).toEqual({ name: "foo", description: "a style", body: "The body.", source: "user", path: "/p/foo.md" });
  });

  test("propagates frontmatter error with path", () => {
    const result = parser.parse("no frontmatter", "/p/x.md", "preset");
    expect(result.style).toBeNull();
    expect(result.error).toEqual({ path: "/p/x.md", message: "missing frontmatter opening delimiter" });
  });

  test("missing name", () => {
    const result = parser.parse("---\ndescription: d\n---\nbody", "/p.md", "user");
    expect(result.error?.message).toBe('frontmatter "name" is required and must be non-empty');
  });

  test("empty name", () => {
    const result = parser.parse("---\nname: \"\"\ndescription: d\n---\nbody", "/p.md", "user");
    expect(result.error?.message).toBe('frontmatter "name" is required and must be non-empty');
  });

  test("name with whitespace", () => {
    const result = parser.parse("---\nname: two words\ndescription: d\n---\nbody", "/p.md", "user");
    expect(result.error?.message).toBe('frontmatter "name" must be a single word without whitespace');
  });

  test("reserved off name (case-insensitive)", () => {
    expect(parser.parse("---\nname: off\ndescription: d\n---\nbody", "/p.md", "user").error?.message).toBe('"off" is a reserved style name');
    expect(parser.parse("---\nname: OFF\ndescription: d\n---\nbody", "/p.md", "user").error?.message).toBe('"off" is a reserved style name');
  });

  test("missing description", () => {
    const result = parser.parse("---\nname: foo\n---\nbody", "/p.md", "user");
    expect(result.error?.message).toBe('frontmatter "description" is required and must be non-empty');
  });

  test("empty body", () => {
    const result = parser.parse("---\nname: foo\ndescription: d\n---\n   ", "/p.md", "user");
    expect(result.error?.message).toBe("style body is empty");
  });

  test("validation order: name checked before description before body", () => {
    const result = parser.parse("---\ndescription: \n---\n", "/p.md", "user");
    expect(result.error?.message).toBe('frontmatter "name" is required and must be non-empty');
  });
});
