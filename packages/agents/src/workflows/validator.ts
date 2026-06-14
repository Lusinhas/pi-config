export class SchemaValidator {
  validate(value: unknown, schema: unknown, path = "$"): string[] {
    if (!SchemaValidator.isRecord(schema)) {
      return []
    }

    const errors: string[] = []
    const actual = SchemaValidator.kindOf(value)
    const expected = typeof schema.type === "string" ? schema.type : ""

    if (expected !== "") {
      const matches = expected === "integer" ? actual === "number" && Number.isInteger(value) : expected === actual

      if (!matches) {
        errors.push(`${path}: expected ${expected}, got ${actual}`)

        return errors
      }
    }

    const allowed = schema.enum

    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.some((option) => SchemaValidator.deepEqual(option, value))) {
      errors.push(`${path}: value is not one of the allowed enum values`)
    }

    if (SchemaValidator.isRecord(value)) {
      const required = schema.required

      if (Array.isArray(required)) {
        for (const key of required) {
          if (typeof key === "string" && !(key in value)) {
            errors.push(`${path}.${key}: missing required property`)
          }
        }
      }

      const properties = schema.properties

      if (SchemaValidator.isRecord(properties)) {
        for (const [key, sub] of Object.entries(properties)) {
          if (key in value) {
            errors.push(...this.validate(value[key], sub, `${path}.${key}`))
          }
        }
      }
    }

    const items = schema.items

    if (Array.isArray(value) && SchemaValidator.isRecord(items)) {
      for (let index = 0; index < value.length; index += 1) {
        errors.push(...this.validate(value[index], items, `${path}[${index}]`))
      }
    }

    return errors
  }

  static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  static kindOf(value: unknown): string {
    if (value === null) {
      return "null"
    }

    if (Array.isArray(value)) {
      return "array"
    }

    return typeof value
  }

  static deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
      return true
    }

    if (typeof a !== typeof b) {
      return false
    }

    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false
      }

      for (let index = 0; index < a.length; index += 1) {
        if (!SchemaValidator.deepEqual(a[index], b[index])) {
          return false
        }
      }

      return true
    }

    if (SchemaValidator.isRecord(a) && SchemaValidator.isRecord(b)) {
      const keysA = Object.keys(a)
      const keysB = Object.keys(b)

      if (keysA.length !== keysB.length) {
        return false
      }

      for (const key of keysA) {
        if (!(key in b) || !SchemaValidator.deepEqual(a[key], b[key])) {
          return false
        }
      }

      return true
    }

    return false
  }
}
