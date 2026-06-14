import { describe, expect, test } from "bun:test"
import { ScriptParser, SCRIPT_BYTES } from "../../src/workflows/parser.ts"

const parser = new ScriptParser()

describe("ScriptParser.parse", () => {
  test("parses meta and strips export from body", () => {
    const script = "export const meta = { name: \"demo\", description: \"does things\" }\nreturn 42"
    const parsed = parser.parse(script)

    expect(parsed.meta.name).toBe("demo")
    expect(parsed.meta.description).toBe("does things")
    expect(parsed.meta.phases).toEqual([])
    expect(parsed.body).toBe("const meta = { name: \"demo\", description: \"does things\" }\nreturn 42")
  })

  test("non-exported const meta is also accepted", () => {
    const script = "const meta = { name: \"a\", description: \"b\" }\nreturn 1"
    const parsed = parser.parse(script)

    expect(parsed.meta.name).toBe("a")
    expect(parsed.body.startsWith("const meta")).toBe(true)
  })

  test("phases normalized; invalid entries skipped", () => {
    const script = `export const meta = {
      name: "p",
      description: "d",
      phases: [{ title: "scan", detail: "x", model: "fast" }, { title: "  " }, { detail: "no title" }, "bad", { title: "build" }]
    }
    return null`
    const parsed = parser.parse(script)

    expect(parsed.meta.phases).toEqual([
      { title: "scan", detail: "x", model: "fast" },
      { title: "build", detail: "", model: "" }
    ])
  })

  test("title and whenToUse captured", () => {
    const script = "export const meta = { name: \"n\", description: \"d\", title: \"T\", whenToUse: \"W\" }\nreturn 0"
    const parsed = parser.parse(script)

    expect(parsed.meta.title).toBe("T")
    expect(parsed.meta.whenToUse).toBe("W")
  })

  test("leading comments and whitespace before meta are allowed", () => {
    const script = "// a comment\n/* block */\n  export const meta = { name: \"c\", description: \"d\" }\nreturn 1"
    const parsed = parser.parse(script)

    expect(parsed.meta.name).toBe("c")
  })

  test("braces inside strings do not confuse the literal scanner", () => {
    const script = "export const meta = { name: \"n\", description: \"a } close brace\" }\nreturn 1"
    const parsed = parser.parse(script)

    expect(parsed.meta.description).toBe("a } close brace")
  })

  test("empty script rejected", () => {
    expect(() => parser.parse("")).toThrow("workflow: the script is empty")
    expect(() => parser.parse("   \n  ")).toThrow("workflow: the script is empty")
  })

  test("oversized script rejected", () => {
    const big = "export const meta = { name: \"n\", description: \"d\" }\n" + "x".repeat(SCRIPT_BYTES)

    expect(() => parser.parse(big)).toThrow(`workflow: the script exceeds the ${SCRIPT_BYTES}-byte limit`)
  })

  test("missing meta statement rejected", () => {
    expect(() => parser.parse("return 1")).toThrow("must be the first statement in the script")
  })

  test("meta not an object literal rejected", () => {
    expect(() => parser.parse("export const meta = 5\nreturn 1")).toThrow("workflow: meta must be an object literal")
  })

  test("unclosed literal rejected", () => {
    expect(() => parser.parse("export const meta = { name: \"n\"\nreturn 1")).toThrow("workflow: the meta object literal is never closed")
  })

  test("impure meta rejected", () => {
    expect(() => parser.parse("export const meta = { name: notDefinedAnywhere(), description: \"d\" }\nreturn 1")).toThrow("workflow: meta must be a pure literal object")
  })

  test("empty name rejected", () => {
    expect(() => parser.parse("export const meta = { name: \"\", description: \"d\" }\nreturn 1")).toThrow("workflow: meta.name must be a non-empty string")
  })

  test("empty description rejected", () => {
    expect(() => parser.parse("export const meta = { name: \"n\", description: \"   \" }\nreturn 1")).toThrow("workflow: meta.description must be a non-empty string")
  })

  test("skipString handles escapes", () => {
    expect(ScriptParser.skipString("\"a\\\"b\"x", 0)).toBe(6)
  })

  test("literalEnd returns -1 for unbalanced", () => {
    expect(ScriptParser.literalEnd("{ a: 1", 0)).toBe(-1)
  })
})
