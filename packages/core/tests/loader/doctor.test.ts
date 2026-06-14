import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FrontmatterParser } from "../../src/loader/frontmatter.ts"
import { DoctorReport } from "../../src/loader/doctor.ts"
import { DuplicateNameValidator, ResourceContentValidator, SuiteConfigValidator } from "../../src/loader/validators.ts"
import type { ResourceCatalogResult, ResourceKind, ResourceRecord } from "../../src/loader/index.ts"

describe("FrontmatterParser.parse", () => {
  const parser = new FrontmatterParser()

  test("reports no frontmatter when the first line is not a fence", () => {
    const fm = parser.parse("just body\nmore")
    expect(fm).toEqual({ ok: true, hasFrontmatter: false, data: {}, body: "just body\nmore" })
  })

  test("strips a leading BOM before inspecting", () => {
    const fm = parser.parse("﻿---\nname: a\n---\nbody")
    expect(fm.hasFrontmatter).toBe(true)
    expect(fm.data.name).toBe("a")
  })

  test("flags an unterminated block", () => {
    const fm = parser.parse("---\nname: a\nno close")
    expect(fm).toEqual({ ok: false, hasFrontmatter: true, data: {}, body: "", error: "unterminated frontmatter block" })
  })

  test("accepts a ... terminator and joins the body with newlines", () => {
    const fm = parser.parse("---\nname: a\n...\nline1\nline2")
    expect(fm.ok).toBe(true)
    expect(fm.body).toBe("line1\nline2")
  })

  test("strips paired quotes from values", () => {
    const fm = parser.parse(`---\na: "quoted"\nb: 'single'\n---\n`)
    expect(fm.data.a).toBe("quoted")
    expect(fm.data.b).toBe("single")
  })

  test("skips comments, indented lines, and list items", () => {
    const fm = parser.parse("---\n# comment\nname: a\n  indented: x\n- item\n---\n")
    expect(fm.data).toEqual({ name: "a" })
  })

  test("joins block scalar continuation lines with spaces", () => {
    const fm = parser.parse("---\ndescription: |\n  line one\n  line two\nname: a\n---\n")
    expect(fm.data.description).toBe("line one line two")
    expect(fm.data.name).toBe("a")
  })

  test("rejects a malformed key line with its line number", () => {
    const fm = parser.parse("---\nname a\n---\n")
    expect(fm.ok).toBe(false)
    expect(fm.error).toBe("invalid frontmatter line 2: name a")
  })
})

function resource(kind: ResourceKind, file: string): ResourceRecord {
  return {
    kind,
    path: file,
    contentPath: file,
    relativePath: file,
  }
}

function catalog(root: string, partial: Partial<ResourceCatalogResult>): ResourceCatalogResult {
  return {
    root,
    prompts: [],
    skills: [],
    themes: [],
    agents: [],
    errors: [],
    warnings: [],
    ...partial,
  }
}

function colors(count: number): Record<string, string> {
  const out: Record<string, string> = {}

  for (let i = 0; i < count; i++) {
    out[`c${i}`] = "#000000"
  }

  return out
}

describe("ResourceContentValidator", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loader-doctor-"))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeSkill(name: string, body: string): string {
    const dir = join(root, "skills", name)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "skill.md")
    writeFileSync(file, body)
    return file
  }

  function run(partial: Partial<ResourceCatalogResult>): { errors: string[]; warnings: string[] } {
    const errors: string[] = []
    const warnings: string[] = []
    new ResourceContentValidator(root, errors, warnings).validate(catalog(root, partial))
    return { errors, warnings }
  }

  test("a clean tree produces no errors and no warnings", () => {
    const skill = writeSkill("alpha", "---\nname: alpha\ndescription: d\n---\nbody")
    const prompt = join(root, "p.md")
    const theme = join(root, "t.json")
    const agent = join(root, "a.md")
    writeFileSync(prompt, "---\nname: p\n---\nbody")
    writeFileSync(theme, JSON.stringify({ name: "t", colors: colors(51) }))
    writeFileSync(agent, "---\nname: agentone\ndescription: d\nmodel: m\ntools: t\nthinking: high\n---\nbody")

    const out = run({
      skills: [resource("skill", skill)],
      prompts: [resource("prompt", prompt)],
      themes: [resource("theme", theme)],
      agents: [resource("agent", agent)],
    })

    expect(out.errors).toEqual([])
    expect(out.warnings).toEqual([])
  })

  test("skill missing frontmatter name and description errors", () => {
    const skill = writeSkill("alpha", "---\ntitle: x\n---\nbody")
    const out = run({ skills: [resource("skill", skill)] })
    expect(out.errors).toContain(`${join("skills", "alpha", "skill.md")}: frontmatter missing name`)
    expect(out.errors).toContain(`${join("skills", "alpha", "skill.md")}: frontmatter missing description`)
  })

  test("skill name falls back to the skill folder name", () => {
    const skill = writeSkill("alpha", "body without frontmatter")
    const errors: string[] = []
    const warnings: string[] = []
    const validation = new ResourceContentValidator(root, errors, warnings).validate(
      catalog(root, { skills: [resource("skill", skill)] }),
    )
    expect(validation.skills[0].name).toBe("alpha")
  })

  test("theme with the wrong key count errors", () => {
    const theme = join(root, "bad.json")
    writeFileSync(theme, JSON.stringify({ name: "bad", colors: colors(50) }))
    const out = run({ themes: [resource("theme", theme)] })
    expect(out.errors).toContain("bad.json: colors has 50 keys, expected exactly 51")
  })

  test("non-string color values warn without erroring the key count", () => {
    const theme = join(root, "warn.json")
    writeFileSync(theme, JSON.stringify({ name: "warn", colors: { ...colors(50), x: 5 } }))
    const out = run({ themes: [resource("theme", theme)] })
    expect(out.errors.some((e) => e.includes("keys, expected exactly 51"))).toBe(false)
    expect(out.warnings).toContain("warn.json: non-string color values: x")
  })

  test("agent name with whitespace must be a single word", () => {
    const agent = join(root, "a.md")
    writeFileSync(agent, "---\nname: two words\ndescription: d\nmodel: m\ntools: t\nthinking: high\n---\nbody")
    const out = run({ agents: [resource("agent", agent)] })
    expect(out.errors).toContain('a.md: agent name "two words" must be a single word')
  })

  test("invalid agent thinking level errors", () => {
    const agent = join(root, "a.md")
    writeFileSync(agent, "---\nname: agentone\ndescription: d\nmodel: m\ntools: t\nthinking: turbo\n---\nbody")
    const out = run({ agents: [resource("agent", agent)] })
    expect(out.errors).toContain('a.md: invalid thinking level "turbo" (expected off|minimal|low|medium|high|xhigh)')
  })

  test("empty agent body warns", () => {
    const agent = join(root, "a.md")
    writeFileSync(agent, "---\nname: agentone\ndescription: d\nmodel: m\ntools: t\nthinking: high\n---\n")
    const out = run({ agents: [resource("agent", agent)] })
    expect(out.warnings).toContain("a.md: empty system prompt body")
  })

  test("duplicate skill names error via DuplicateNameValidator", () => {
    const skillA = writeSkill("alpha", "---\nname: same\ndescription: d\n---\nbody")
    const skillB = writeSkill("beta", "---\nname: same\ndescription: d\n---\nbody")
    const errors: string[] = []
    const warnings: string[] = []
    const validation = new ResourceContentValidator(root, errors, warnings).validate(
      catalog(root, { skills: [resource("skill", skillA), resource("skill", skillB)] }),
    )
    const dupes: string[] = []
    new DuplicateNameValidator().find(validation.skills, "skill", dupes)
    expect(dupes.some((e) => e.startsWith('duplicate skill name "same"'))).toBe(true)
  })
})

describe("SuiteConfigValidator", () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "loader-suite-"))
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  test("reports not present when absent", () => {
    const errors: string[] = []
    const lines = new SuiteConfigValidator().validate(cwd, errors)
    expect(lines).toContain("  .pi/suite.json: not present")
  })

  test("reports an ok suite.json with its section count", () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true })
    writeFileSync(join(cwd, ".pi", "suite.json"), JSON.stringify({ a: 1, b: 2 }))
    const errors: string[] = []
    const lines = new SuiteConfigValidator().validate(cwd, errors)
    expect(lines).toContain("  .pi/suite.json: ok (2 sections)")
  })

  test("reports an invalid suite.json that is not a JSON object", () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true })
    writeFileSync(join(cwd, ".pi", "suite.json"), "[1,2,3]")
    const errors: string[] = []
    const lines = new SuiteConfigValidator().validate(cwd, errors)
    expect(lines).toContain("  .pi/suite.json: INVALID")
    expect(errors).toContain(".pi/suite.json: top level must be a JSON object")
  })

  test("reports a suite.json with malformed JSON", () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true })
    writeFileSync(join(cwd, ".pi", "suite.json"), "{not json")
    const errors: string[] = []
    const lines = new SuiteConfigValidator().validate(cwd, errors)
    expect(lines).toContain("  .pi/suite.json: INVALID")
    expect(errors.some((e) => e.startsWith(".pi/suite.json: invalid JSON ("))).toBe(true)
  })
})

describe("DoctorReport.build", () => {
  test("assembles the header, compact resource census, and summary lines", () => {
    const root = "/tmp/suite"
    const resources = catalog(root, {
      skills: [resource("skill", "/tmp/suite/skills/a/skill.md")],
      prompts: [
        resource("prompt", "/tmp/suite/prompts/a.md"),
        resource("prompt", "/tmp/suite/prompts/b.md"),
      ],
      themes: [resource("theme", "/tmp/suite/themes/t.json")],
    })
    const validation = { skills: [], prompts: [], themes: [], agents: [] }
    const errors: string[] = []
    const warnings: string[] = []
    const report = new DoctorReport().build(resources, validation, ["  .pi/suite.json: not present"], errors, warnings)

    expect(report).toContain(`pi-config doctor — ${root}`)
    expect(report).not.toContain("packages:")
    expect(report).toContain("resources: skills 1 prompts 2 themes 1 agents 0")
    expect(report).toContain("suite.json:")
    expect(report).toContain("  .pi/suite.json: not present")
    expect(report).toContain("summary: 4 resources checked, 0 error(s), 0 warning(s)")
  })

  test("includes errors and warnings sections and counts duplicates", () => {
    const resources = catalog("/tmp/suite", {})
    const validation = {
      skills: [
        { name: "same", path: "a/skill.md" },
        { name: "same", path: "b/skill.md" },
      ],
      prompts: [],
      themes: [],
      agents: [],
    }
    const errors = ["themes/bad.json: theme missing colors object"]
    const warnings = ["agents directory is missing"]
    const report = new DoctorReport().build(resources, validation, [], errors, warnings)

    expect(report).toContain("errors:")
    expect(report).toContain('  duplicate skill name "same": a/skill.md, b/skill.md')
    expect(report).toContain("warnings:")
    expect(report).toContain("summary: 0 resources checked, 2 error(s), 1 warning(s)")
  })
})
