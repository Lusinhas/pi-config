import { describe, expect, test } from "bun:test"
import { GlobMatcher, ProtectFilter } from "../../src/syntax/glob.ts"

describe("GlobMatcher.toRegExp", () => {
  test("**/ matches zero or more leading directories", () => {
    const regex = GlobMatcher.toRegExp("**/node_modules/**")

    expect(regex.test("node_modules/a")).toBe(true)
    expect(regex.test("src/node_modules/a/b")).toBe(true)
    expect(regex.test("src/foo.ts")).toBe(false)
  })

  test("single star stays within a path segment", () => {
    const regex = GlobMatcher.toRegExp("*.min.js")

    expect(regex.test("a.min.js")).toBe(true)
    expect(regex.test("dir/a.min.js")).toBe(false)
  })

  test("question mark matches one non-slash char", () => {
    const regex = GlobMatcher.toRegExp("a?c")

    expect(regex.test("abc")).toBe(true)
    expect(regex.test("a/c")).toBe(false)
    expect(regex.test("ac")).toBe(false)
  })

  test("escapes regex metacharacters in literals", () => {
    const regex = GlobMatcher.toRegExp("a.b+c")

    expect(regex.test("a.b+c")).toBe(true)
    expect(regex.test("aXbXc")).toBe(false)
  })

  test("bare ** not followed by slash matches across slashes (pinned quirk)", () => {
    const regex = GlobMatcher.toRegExp("a**b")

    expect(regex.test("aXXXb")).toBe(true)
    expect(regex.test("aX/Yb")).toBe(true)
  })

  test("*.generated.* matches double extension", () => {
    const regex = GlobMatcher.toRegExp("**/*.generated.*")

    expect(regex.test("src/foo.generated.ts")).toBe(true)
    expect(regex.test("foo.generated.ts")).toBe(true)
    expect(regex.test("foo.ts")).toBe(false)
  })
})

describe("GlobMatcher.compile", () => {
  test("returns undefined for blank glob", () => {
    expect(GlobMatcher.compile("   ")).toBeUndefined()
    expect(GlobMatcher.compile("")).toBeUndefined()
  })

  test("matches against rel, abs, and bare basename", () => {
    const bare = GlobMatcher.compile("yarn.lock")
    expect(bare?.matches("sub/yarn.lock", "/x/sub/yarn.lock", "yarn.lock")).toBe(true)

    const slashed = GlobMatcher.compile("**/dist/**")
    expect(slashed?.matches("dist/a.js", "/x/dist/a.js", "a.js")).toBe(true)
  })

  test("bare matcher does not match basename when glob has a slash", () => {
    const slashed = GlobMatcher.compile("dist/x")
    expect(slashed?.matches("nope", "nope", "x")).toBe(false)
  })
})

describe("ProtectFilter", () => {
  const filter = new ProtectFilter([
    "**/node_modules/**",
    "**/*.min.js",
    "package-lock.json"
  ])

  test("protects files inside protected dirs", () => {
    expect(filter.isProtected({ rel: "node_modules/x/y.js", abs: "/repo/node_modules/x/y.js" })).toBe(true)
  })

  test("protects matching extension globs", () => {
    expect(filter.isProtected({ rel: "src/app.min.js", abs: "/repo/src/app.min.js" })).toBe(true)
  })

  test("protects bare basename anywhere", () => {
    expect(filter.isProtected({ rel: "deep/dir/package-lock.json", abs: "/repo/deep/dir/package-lock.json" })).toBe(true)
  })

  test("leaves ordinary files unprotected", () => {
    expect(filter.isProtected({ rel: "src/app.ts", abs: "/repo/src/app.ts" })).toBe(false)
  })

  test("empty filter protects nothing", () => {
    const none = new ProtectFilter([])
    expect(none.isProtected({ rel: "node_modules/a.js", abs: "/repo/node_modules/a.js" })).toBe(false)
  })

  test("skips invalid glob entries", () => {
    const mixed = new ProtectFilter(["", "   ", "**/dist/**"])
    expect(mixed.isProtected({ rel: "dist/a.js", abs: "/repo/dist/a.js" })).toBe(true)
    expect(mixed.isProtected({ rel: "src/a.js", abs: "/repo/src/a.js" })).toBe(false)
  })

  test("matches against absolute path when rel does not match", () => {
    const filter = new ProtectFilter(["**/vendor/**"])
    expect(filter.isProtected({ rel: "../outside/vendor/lib.js", abs: "/abs/vendor/lib.js" })).toBe(true)
  })
})
