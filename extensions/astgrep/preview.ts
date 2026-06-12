export interface DiffOp {
  type: "same" | "del" | "add"
  text: string
}

export interface Hunk {
  header: string
  lines: string[]
}

export interface FileDiff {
  text: string
  total: number
  shown: number
}

const LCS_BUDGET = 250000
const MAX_DEPTH = 24
const LINE_CLIP = 400

function clipLine(line: string, max: number): string {
  if (line.length <= max) return line
  return `${line.slice(0, max)}…`
}

function splitLines(text: string): string[] {
  const lines = text.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before)
  const b = splitLines(after)
  const ops: DiffOp[] = []
  segment(a, 0, a.length, b, 0, b.length, ops, 0)
  return ops
}

function segment(
  a: string[],
  aLo: number,
  aHi: number,
  b: string[],
  bLo: number,
  bHi: number,
  ops: DiffOp[],
  depth: number
): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    ops.push({ type: "same", text: a[aLo] })
    aLo += 1
    bLo += 1
  }
  const tail: DiffOp[] = []
  while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) {
    tail.push({ type: "same", text: a[aHi - 1] })
    aHi -= 1
    bHi -= 1
  }
  core(a, aLo, aHi, b, bLo, bHi, ops, depth)
  for (let index = tail.length - 1; index >= 0; index -= 1) ops.push(tail[index])
}

function core(
  a: string[],
  aLo: number,
  aHi: number,
  b: string[],
  bLo: number,
  bHi: number,
  ops: DiffOp[],
  depth: number
): void {
  const aLen = aHi - aLo
  const bLen = bHi - bLo
  if (aLen === 0 && bLen === 0) return
  if (aLen === 0) {
    for (let j = bLo; j < bHi; j += 1) ops.push({ type: "add", text: b[j] })
    return
  }
  if (bLen === 0) {
    for (let i = aLo; i < aHi; i += 1) ops.push({ type: "del", text: a[i] })
    return
  }
  if (aLen * bLen <= LCS_BUDGET) {
    lcs(a, aLo, aHi, b, bLo, bHi, ops)
    return
  }
  const emitBlock = (): void => {
    for (let i = aLo; i < aHi; i += 1) ops.push({ type: "del", text: a[i] })
    for (let j = bLo; j < bHi; j += 1) ops.push({ type: "add", text: b[j] })
  }
  if (depth >= MAX_DEPTH) {
    emitBlock()
    return
  }
  const anchors = patienceAnchors(a, aLo, aHi, b, bLo, bHi)
  if (anchors.length === 0) {
    emitBlock()
    return
  }
  let prevA = aLo
  let prevB = bLo
  for (const [anchorA, anchorB] of anchors) {
    segment(a, prevA, anchorA, b, prevB, anchorB, ops, depth + 1)
    ops.push({ type: "same", text: a[anchorA] })
    prevA = anchorA + 1
    prevB = anchorB + 1
  }
  segment(a, prevA, aHi, b, prevB, bHi, ops, depth + 1)
}

function lcs(
  a: string[],
  aLo: number,
  aHi: number,
  b: string[],
  bLo: number,
  bHi: number,
  ops: DiffOp[]
): void {
  const m = aHi - aLo
  const n = bHi - bLo
  const width = n + 1
  const table = new Uint32Array((m + 1) * width)
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (a[aLo + i] === b[bLo + j]) {
        table[i * width + j] = table[(i + 1) * width + j + 1] + 1
      } else {
        const down = table[(i + 1) * width + j]
        const right = table[i * width + j + 1]
        table[i * width + j] = down >= right ? down : right
      }
    }
  }
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[aLo + i] === b[bLo + j]) {
      ops.push({ type: "same", text: a[aLo + i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: "del", text: a[aLo + i] })
      i += 1
    } else {
      ops.push({ type: "add", text: b[bLo + j] })
      j += 1
    }
  }
  while (i < m) {
    ops.push({ type: "del", text: a[aLo + i] })
    i += 1
  }
  while (j < n) {
    ops.push({ type: "add", text: b[bLo + j] })
    j += 1
  }
}

function patienceAnchors(
  a: string[],
  aLo: number,
  aHi: number,
  b: string[],
  bLo: number,
  bHi: number
): Array<[number, number]> {
  const countA = new Map<string, number>()
  const posA = new Map<string, number>()
  for (let i = aLo; i < aHi; i += 1) {
    countA.set(a[i], (countA.get(a[i]) ?? 0) + 1)
    posA.set(a[i], i)
  }
  const countB = new Map<string, number>()
  const posB = new Map<string, number>()
  for (let j = bLo; j < bHi; j += 1) {
    countB.set(b[j], (countB.get(b[j]) ?? 0) + 1)
    posB.set(b[j], j)
  }
  const pairs: Array<[number, number]> = []
  for (const [line, count] of countA) {
    if (count !== 1 || countB.get(line) !== 1) continue
    pairs.push([posA.get(line) as number, posB.get(line) as number])
  }
  pairs.sort((left, right) => left[0] - right[0])
  return longestIncreasing(pairs)
}

function longestIncreasing(pairs: Array<[number, number]>): Array<[number, number]> {
  const tails: number[] = []
  const prev = new Array<number>(pairs.length).fill(-1)
  for (let k = 0; k < pairs.length; k += 1) {
    const bIndex = pairs[k][1]
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pairs[tails[mid]][1] < bIndex) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[k] = tails[lo - 1]
    tails[lo] = k
  }
  const chain: Array<[number, number]> = []
  let at = tails.length > 0 ? tails[tails.length - 1] : -1
  while (at >= 0) {
    chain.push(pairs[at])
    at = prev[at]
  }
  chain.reverse()
  return chain
}

export function buildHunks(ops: DiffOp[], context: number): Hunk[] {
  const changed: number[] = []
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].type !== "same") changed.push(index)
  }
  if (changed.length === 0) return []
  const ranges: Array<[number, number]> = []
  let start = Math.max(0, changed[0] - context)
  let end = Math.min(ops.length - 1, changed[0] + context)
  for (let k = 1; k < changed.length; k += 1) {
    const from = Math.max(0, changed[k] - context)
    const to = Math.min(ops.length - 1, changed[k] + context)
    if (from <= end + 1) {
      end = to
    } else {
      ranges.push([start, end])
      start = from
      end = to
    }
  }
  ranges.push([start, end])
  const aBefore = new Array<number>(ops.length + 1)
  const bBefore = new Array<number>(ops.length + 1)
  let aLine = 0
  let bLine = 0
  for (let index = 0; index < ops.length; index += 1) {
    aBefore[index] = aLine
    bBefore[index] = bLine
    if (ops[index].type !== "add") aLine += 1
    if (ops[index].type !== "del") bLine += 1
  }
  aBefore[ops.length] = aLine
  bBefore[ops.length] = bLine
  const hunks: Hunk[] = []
  for (const [from, to] of ranges) {
    let aCount = 0
    let bCount = 0
    const lines: string[] = []
    for (let index = from; index <= to; index += 1) {
      const op = ops[index]
      if (op.type === "same") {
        aCount += 1
        bCount += 1
        lines.push(` ${clipLine(op.text, LINE_CLIP)}`)
      } else if (op.type === "del") {
        aCount += 1
        lines.push(`-${clipLine(op.text, LINE_CLIP)}`)
      } else {
        bCount += 1
        lines.push(`+${clipLine(op.text, LINE_CLIP)}`)
      }
    }
    const aStart = aCount > 0 ? aBefore[from] + 1 : aBefore[from]
    const bStart = bCount > 0 ? bBefore[from] + 1 : bBefore[from]
    hunks.push({ header: `@@ -${aStart},${aCount} +${bStart},${bCount} @@`, lines })
  }
  return hunks
}

export function renderFileDiff(
  rel: string,
  before: string,
  after: string,
  context: number,
  hunkBudget: number
): FileDiff {
  const hunks = buildHunks(diffLines(before, after), context)
  if (hunks.length === 0) return { text: "", total: 0, shown: 0 }
  const shown = Math.max(0, Math.min(hunks.length, hunkBudget))
  if (shown === 0) return { text: "", total: hunks.length, shown: 0 }
  const parts = [`--- a/${rel}`, `+++ b/${rel}`]
  for (let index = 0; index < shown; index += 1) {
    parts.push(hunks[index].header)
    for (const line of hunks[index].lines) parts.push(line)
  }
  if (shown < hunks.length) parts.push(`… ${hunks.length - shown} more hunks in ${rel} not shown`)
  return { text: parts.join("\n"), total: hunks.length, shown }
}
