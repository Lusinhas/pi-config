import { statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

export interface BashCandidate {
  path: string
  existing: boolean
}

const REDIRECT_BARE = /^(?:\d*|&)>{1,2}$/
const REDIRECT_ATTACHED = /^(?:\d*|&)>{1,2}(.+)$/

export class BashScanner {
  candidates(command: string, cwd: string, limit: number): BashCandidate[] {
    const tokens = this.tokenize(command)
    const out: BashCandidate[] = []
    const seen = new Set<string>()
    const cwdRoot = resolve(cwd)
    let redirectNext = false

    for (const raw of tokens) {
      if (out.length >= limit) {
        break
      }

      if (REDIRECT_BARE.test(raw)) {
        redirectNext = true
        continue
      }

      let token = raw
      let fromRedirect = redirectNext
      redirectNext = false

      const attached = REDIRECT_ATTACHED.exec(raw)

      if (attached && attached[1]) {
        token = attached[1]
        fromRedirect = true
      }

      if (!fromRedirect && token.startsWith("-")) {
        continue
      }

      const expanded = this.expandHome(token)
      const abs = resolve(cwd, expanded)
      const rel = relative(cwdRoot, abs)

      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        continue
      }

      if (seen.has(abs)) {
        continue
      }

      const existing = this.isFile(abs)

      if (!existing && !fromRedirect) {
        continue
      }

      seen.add(abs)
      out.push({ path: abs, existing })
    }

    return out
  }

  tokenize(command: string): string[] {
    const tokens: string[] = []
    let current = ""
    let quote: string | null = null

    for (let i = 0; i < command.length; i++) {
      const ch = command[i]

      if (quote) {
        if (ch === quote) {
          quote = null
        } else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
          current += command[++i]
        } else {
          current += ch
        }

        continue
      }

      if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === "\\" && i + 1 < command.length) {
        current += command[++i]
      } else if (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "&") {
        if (current) {
          tokens.push(current)
          current = ""
        }
      } else {
        current += ch
      }
    }

    if (current) {
      tokens.push(current)
    }

    return tokens
  }

  private expandHome(token: string): string {
    if (token === "~") {
      return homedir()
    }

    if (token.startsWith("~/")) {
      return join(homedir(), token.slice(2))
    }

    return token
  }

  private isFile(abs: string): boolean {
    try {
      return statSync(abs).isFile()
    } catch {
      return false
    }
  }
}

export class GitPorcelain {
  parse(stdout: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()

    for (const line of stdout.split("\n")) {
      if (line.length < 4) {
        continue
      }

      const code = line.slice(0, 2)
      const rest = line.slice(3)
      let targets: string[]

      if (code.includes("R") || code.includes("C")) {
        const pair = this.splitRename(rest)
        targets = pair ? [pair[0], pair[1]] : [rest]
      } else {
        targets = [rest]
      }

      for (const target of targets) {
        const cleaned = this.unquote(target).replace(/\/+$/, "")

        if (cleaned && !seen.has(cleaned)) {
          seen.add(cleaned)
          out.push(cleaned)
        }
      }
    }

    return out
  }

  private splitRename(rest: string): [string, string] | null {
    if (rest.startsWith('"')) {
      let i = 1

      while (i < rest.length) {
        if (rest[i] === "\\") {
          i += 2
        } else if (rest[i] === '"') {
          break
        } else {
          i++
        }
      }

      const from = rest.slice(0, i + 1)
      const remainder = rest.slice(i + 1)

      if (remainder.startsWith(" -> ")) {
        return [from, remainder.slice(4)]
      }

      return null
    }

    const idx = rest.indexOf(" -> ")

    if (idx === -1) {
      return null
    }

    return [rest.slice(0, idx), rest.slice(idx + 4)]
  }

  private unquote(value: string): string {
    if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
      return value
    }

    const inner = value.slice(1, -1)
    const bytes: number[] = []

    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]

      if (ch !== "\\") {
        for (const byte of Buffer.from(ch, "utf8")) {
          bytes.push(byte)
        }

        continue
      }

      const next = inner[i + 1]

      if (next === undefined) {
        break
      }

      if (next >= "0" && next <= "7") {
        let digits = ""

        while (digits.length < 3 && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
          digits += inner[i + 1]
          i++
        }

        bytes.push(Number.parseInt(digits, 8) & 0xff)
        continue
      }

      i++

      if (next === "n") {
        bytes.push(10)
      } else if (next === "t") {
        bytes.push(9)
      } else if (next === "r") {
        bytes.push(13)
      } else if (next === "a") {
        bytes.push(7)
      } else if (next === "b") {
        bytes.push(8)
      } else if (next === "f") {
        bytes.push(12)
      } else if (next === "v") {
        bytes.push(11)
      } else {
        for (const byte of Buffer.from(next, "utf8")) {
          bytes.push(byte)
        }
      }
    }

    return Buffer.from(bytes).toString("utf8")
  }
}
