import { describe, expect, test } from "bun:test"
import { SchemaValidator } from "../../src/workflows/validator.ts"

const v = new SchemaValidator()

describe("SchemaValidator", () => {
  test("non-record schema permits anything", () => {
    expect(v.validate(123, null)).toEqual([])
    expect(v.validate("x", "string")).toEqual([])
  })

  test("type mismatch reports path and stops recursion", () => {
    expect(v.validate(5, { type: "string" })).toEqual(["$: expected string, got number"])
  })

  test("integer requires whole number", () => {
    expect(v.validate(3.5, { type: "integer" })).toEqual(["$: expected integer, got number"])
    expect(v.validate(3, { type: "integer" })).toEqual([])
  })

  test("array and null kinds", () => {
    expect(v.validate([], { type: "array" })).toEqual([])
    expect(v.validate(null, { type: "null" })).toEqual([])
    expect(v.validate({}, { type: "object" })).toEqual([])
  })

  test("required reports missing properties", () => {
    const errors = v.validate({ a: 1 }, { type: "object", required: ["a", "b"] })

    expect(errors).toEqual(["$.b: missing required property"])
  })

  test("nested property recursion", () => {
    const schema = { type: "object", properties: { age: { type: "integer" } } }

    expect(v.validate({ age: "old" }, schema)).toEqual(["$.age: expected integer, got string"])
  })

  test("only recurses into present properties", () => {
    const schema = { type: "object", properties: { missing: { type: "string" } } }

    expect(v.validate({}, schema)).toEqual([])
  })

  test("items validates each element with index path", () => {
    const schema = { type: "array", items: { type: "number" } }
    const errors = v.validate([1, "two", 3, "four"], schema)

    expect(errors).toEqual(["$[1]: expected number, got string", "$[3]: expected number, got string"])
  })

  test("enum primitive membership", () => {
    expect(v.validate("b", { enum: ["a", "b", "c"] })).toEqual([])
    expect(v.validate("z", { enum: ["a", "b"] })).toEqual(["$: value is not one of the allowed enum values"])
  })

  test("enum deep-equal is order-insensitive for object values", () => {
    const schema = { enum: [{ a: 1, b: 2 }] }

    expect(v.validate({ b: 2, a: 1 }, schema)).toEqual([])
  })

  test("enum deep-equal for arrays preserves order sensitivity within arrays", () => {
    const schema = { enum: [[1, 2, 3]] }

    expect(v.validate([1, 2, 3], schema)).toEqual([])
    expect(v.validate([3, 2, 1], schema)).toEqual(["$: value is not one of the allowed enum values"])
  })

  test("deepEqual handles nested mixed structures", () => {
    expect(SchemaValidator.deepEqual({ x: [1, { y: 2 }] }, { x: [1, { y: 2 }] })).toBe(true)
    expect(SchemaValidator.deepEqual({ x: [1, { y: 2 }] }, { x: [1, { y: 3 }] })).toBe(false)
    expect(SchemaValidator.deepEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(SchemaValidator.deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })

  test("multiple errors collected across properties and items", () => {
    const schema = {
      type: "object",
      required: ["id"],
      properties: { tags: { type: "array", items: { type: "string" } } }
    }
    const errors = v.validate({ tags: ["ok", 5] }, schema)

    expect(errors).toContain("$.id: missing required property")
    expect(errors).toContain("$.tags[1]: expected string, got number")
  })
})
