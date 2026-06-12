function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function kindOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export function validate(value: unknown, schema: unknown, path = "$"): string[] {
  if (!isRecord(schema)) return []
  const errors: string[] = []
  const actual = kindOf(value)
  const expected = typeof schema.type === "string" ? schema.type : ""
  if (expected !== "") {
    const matches = expected === "integer" ? actual === "number" && Number.isInteger(value) : expected === actual
    if (!matches) {
      errors.push(`${path}: expected ${expected}, got ${actual}`)
      return errors
    }
  }
  const allowed = schema.enum
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.some((option) => sameJson(option, value))) {
    errors.push(`${path}: value is not one of the allowed enum values`)
  }
  if (isRecord(value)) {
    const required = schema.required
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !(key in value)) errors.push(`${path}.${key}: missing required property`)
      }
    }
    const properties = schema.properties
    if (isRecord(properties)) {
      for (const [key, sub] of Object.entries(properties)) {
        if (key in value) errors.push(...validate(value[key], sub, `${path}.${key}`))
      }
    }
  }
  const items = schema.items
  if (Array.isArray(value) && isRecord(items)) {
    for (let index = 0; index < value.length; index += 1) {
      errors.push(...validate(value[index], items, `${path}[${index}]`))
    }
  }
  return errors
}
