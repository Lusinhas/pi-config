import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  loadRegistry,
  parseAgentFile,
  parseDocument,
  RegistryLoader,
  stripQuotes,
  THINKING_LEVELS
} from "../../src/subagents/registry.ts"

const SHIPPED_AGENTS = [
  "advisory/oracle.md",
  "build/coder.md",
  "build/tester.md",
  "planning/architect.md",
  "planning/critic.md",
  "research/explorer.md",
  "research/librarian.md",
  "review/reviewer.md",
  "review/security.md",
  "security/attacksurface.md",
  "security/pentestrunner.md",
  "security/reporter.md",
  "security/vulntracer.md"
]

function shippedPaths(): string[] {
  return SHIPPED_AGENTS.map((relative) => fileURLToPath(new URL(`../../../../agents/${relative}`, import.meta.url)))
}

describe("stripQuotes", () => {
  test("removes matching surrounding quotes", () => {
    expect(stripQuotes("\"hi\"")).toBe("hi")
    expect(stripQuotes("'hi'")).toBe("hi")
  })

  test("leaves mismatched or unquoted values alone", () => {
    expect(stripQuotes("\"hi'")).toBe("\"hi'")
    expect(stripQuotes("hi")).toBe("hi")
    expect(stripQuotes("\"")).toBe("\"")
  })
})

describe("parseDocument", () => {
  test("parses frontmatter after leading blank lines", () => {
    const result = parseDocument("\n\n---\nname: a\n---\nbody")
    expect(typeof result).not.toBe("string")
    if (typeof result !== "string") {
      expect(result.fields.name).toBe("a")
      expect(result.body).toBe("body")
    }
  })

  test("reports a missing opening delimiter", () => {
    expect(parseDocument("name: a")).toBe("missing frontmatter opening ---")
  })

  test("reports a missing closing delimiter", () => {
    expect(parseDocument("---\nname: a")).toBe("missing frontmatter closing ---")
  })

  test("reports an invalid frontmatter line", () => {
    expect(parseDocument("---\nbadline\n---\nbody")).toContain("invalid frontmatter line")
  })

  test("lowercases keys and skips comments", () => {
    const result = parseDocument("---\n# comment\nNAME: a\n---\nbody")
    if (typeof result !== "string") {
      expect(result.fields.name).toBe("a")
    }
  })
})

describe("parseAgentFile", () => {
  test("parses a full definition", () => {
    const text = "---\nname: coder\ndescription: does things\nmodel: inherit\ntools: read bash\nthinking: medium\n---\nYou are coder."
    const { definition, error } = parseAgentFile("file.md", text)
    expect(error).toBeUndefined()
    expect(definition?.name).toBe("coder")
    expect(definition?.tools).toEqual(["read", "bash"])
    expect(definition?.thinking).toBe("medium")
    expect(definition?.prompt).toBe("You are coder.")
  })

  test("defaults model to inherit and tools to all", () => {
    const { definition } = parseAgentFile("f.md", "---\nname: a\ndescription: d\n---\nbody")
    expect(definition?.model).toBe("inherit")
    expect(definition?.tools).toBe("all")
    expect(definition?.thinking).toBe("")
  })

  test("dedups tool names and treats 'all' as all", () => {
    const a = parseAgentFile("f.md", "---\nname: a\ndescription: d\ntools: read, read bash\n---\nbody")
    expect(a.definition?.tools).toEqual(["read", "bash"])
    const b = parseAgentFile("f.md", "---\nname: a\ndescription: d\ntools: ALL\n---\nbody")
    expect(b.definition?.tools).toBe("all")
  })

  test("rejects a missing name", () => {
    expect(parseAgentFile("f.md", "---\ndescription: d\n---\nbody").error?.reason).toBe("frontmatter is missing required key: name")
  })

  test("rejects an invalid name", () => {
    expect(parseAgentFile("f.md", "---\nname: 9bad\ndescription: d\n---\nbody").error?.reason).toContain("must be a single word")
  })

  test("rejects a missing description", () => {
    expect(parseAgentFile("f.md", "---\nname: a\n---\nbody").error?.reason).toBe("frontmatter is missing required key: description")
  })

  test("rejects an invalid thinking level", () => {
    expect(parseAgentFile("f.md", "---\nname: a\ndescription: d\nthinking: deep\n---\nbody").error?.reason).toContain("invalid thinking level")
  })

  test("rejects an empty body", () => {
    expect(parseAgentFile("f.md", "---\nname: a\ndescription: d\n---\n   ").error?.reason).toBe("agent body (system prompt) is empty")
  })

  test("accepts every documented thinking level", () => {
    for (const level of THINKING_LEVELS) {
      const { definition } = parseAgentFile("f.md", `---\nname: a\ndescription: d\nthinking: ${level}\n---\nbody`)
      expect(definition?.thinking).toBe(level)
    }
  })
})

describe("RegistryLoader", () => {
  test("loads the thirteen shipped agents with no errors", () => {
    const loader = new RegistryLoader(shippedPaths())
    const registry = loader.load(tmpdir())
    expect(registry.agents.size).toBe(13)
    expect(registry.errors).toEqual([])
    for (const name of ["oracle", "coder", "tester", "architect", "critic", "explorer", "librarian", "reviewer", "security", "security-attack-surface", "security-vuln-tracer", "security-pentest-runner", "security-reporter"]) {
      expect(registry.agents.has(name)).toBe(true)
    }
  })

  test("reports the shipped file paths it searched", () => {
    const paths = shippedPaths()
    const registry = new RegistryLoader(paths).load(tmpdir())
    expect(registry.paths).toEqual(paths)
  })

  test("ignores cwd: two different cwds yield the same agents", () => {
    const loader = new RegistryLoader(shippedPaths())
    const first = loader.load(tmpdir())
    const second = loader.load(join(tmpdir(), "elsewhere"))
    expect([...second.agents.keys()].sort()).toEqual([...first.agents.keys()].sort())
    expect(second.agents.size).toBe(13)
  })

  test("records a parse error for an unreadable manifest path", () => {
    const missing = join(tmpdir(), "subagents-missing-agent-file.md")
    const loader = new RegistryLoader([missing])
    const registry = loader.load(tmpdir())
    expect(registry.agents.size).toBe(0)
    expect(registry.errors.some((error) => error.source === missing && error.reason.startsWith("unreadable:"))).toBe(true)
  })

  test("loadRegistry loads the package manifest independent of cwd", () => {
    const a = loadRegistry(tmpdir())
    const b = loadRegistry(join(tmpdir(), "elsewhere"))
    expect(a.agents.size).toBe(13)
    expect([...b.agents.keys()].sort()).toEqual([...a.agents.keys()].sort())
  })
})
