import { sep } from "node:path"

export interface ProtectTarget {
  rel: string
  abs: string
}

export class GlobCompiler {
  static toRegExp(glob: string): RegExp {
    let pattern = "^"
    let index = 0

    while (index < glob.length) {
      const char = glob[index]

      if (char === "*") {
        if (glob[index + 1] === "*") {
          if (glob[index + 2] === "/") {
            pattern += "(?:[^/]*/)*"
            index += 3
          } else {
            pattern += ".*"
            index += 2
          }
        } else {
          pattern += "[^/]*"
          index += 1
        }
      } else if (char === "?") {
        pattern += "[^/]"
        index += 1
      } else {
        pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
        index += 1
      }
    }

    return new RegExp(`${pattern}$`)
  }
}

export class GlobMatcher {
  private readonly regex: RegExp
  private readonly bare: boolean

  private constructor(regex: RegExp, bare: boolean) {
    this.regex = regex
    this.bare = bare
  }

  static compile(glob: string): GlobMatcher | undefined {
    const trimmed = glob.trim()

    if (trimmed === "") {
      return undefined
    }

    let regex: RegExp

    try {
      regex = GlobCompiler.toRegExp(trimmed)
    } catch {
      return undefined
    }

    return new GlobMatcher(regex, !glob.includes("/"))
  }

  static toRegExp(glob: string): RegExp {
    return GlobCompiler.toRegExp(glob)
  }

  matches(rel: string, abs: string, base: string): boolean {
    return this.regex.test(rel) || this.regex.test(abs) || (this.bare && this.regex.test(base))
  }
}

export class ProtectFilter {
  private readonly matchers: GlobMatcher[]

  constructor(globs: string[]) {
    const matchers: GlobMatcher[] = []

    for (const glob of globs) {
      if (typeof glob !== "string" || glob.trim() === "") {
        continue
      }

      const matcher = GlobMatcher.compile(glob)

      if (matcher) {
        matchers.push(matcher)
      }
    }

    this.matchers = matchers
  }

  isProtected(file: ProtectTarget): boolean {
    const abs = file.abs.split(sep).join("/")
    const base = abs.slice(abs.lastIndexOf("/") + 1)

    return this.matchers.some((matcher) => matcher.matches(file.rel, abs, base))
  }
}
