import { emptyTotals, isEmptyTotals, loadHistory, toCount } from "./track"
import type { ModelTotals, SessionSnapshot } from "./track"

function scaled(value: number): string {
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  const text = value.toFixed(digits)
  if (!text.includes(".")) return text
  return text.replace(/0+$/, "").replace(/\.$/, "")
}

export function humanTokens(value: number): string {
  const safe = toCount(value)
  if (safe < 1000) return String(Math.round(safe))
  if (safe < 1e6) return `${scaled(safe / 1000)}k`
  return `${scaled(safe / 1e6)}M`
}

export function formatCost(value: number, decimals: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0
  return `$${safe.toFixed(decimals)}`
}

function renderTable(headers: string[], rows: string[][], numeric: boolean[]): string {
  const widths = headers.map((header, index) => {
    let width = header.length
    for (const row of rows) width = Math.max(width, (row[index] ?? "").length)
    return width
  })
  const format = (cells: string[]): string =>
    cells
      .map((cell, index) => {
        const text = cell ?? ""
        return numeric[index] ? text.padStart(widths[index]) : text.padEnd(widths[index])
      })
      .join("  ")
      .trimEnd()
  const divider = widths.map(width => "-".repeat(width)).join("  ")
  return [format(headers), divider, ...rows.map(format)].join("\n")
}

function usageCells(totals: ModelTotals, decimals: number): string[] {
  return [
    humanTokens(totals.input),
    humanTokens(totals.output),
    humanTokens(totals.cacheRead),
    humanTokens(totals.cacheWrite),
    formatCost(totals.cost, decimals),
    String(totals.turns)
  ]
}

export function renderSession(snapshot: SessionSnapshot, decimals: number): string {
  const ids = Object.keys(snapshot.models)
  if (ids.length === 0 && isEmptyTotals(snapshot.totals)) return "No usage recorded in this session yet."
  ids.sort((a, b) => {
    const byCost = snapshot.models[b].cost - snapshot.models[a].cost
    return byCost !== 0 ? byCost : a.localeCompare(b)
  })
  const rows = ids.map(id => [id, ...usageCells(snapshot.models[id], decimals)])
  rows.push(["total", ...usageCells(snapshot.totals, decimals)])
  const table = renderTable(
    ["model", "input", "output", "cache read", "cache write", "cost", "turns"],
    rows,
    [false, true, true, true, true, true, true]
  )
  return `Session usage\n\n${table}`
}

function dayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function addTotals(target: ModelTotals, source: ModelTotals): void {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.cost += source.cost
  target.turns += source.turns
}

interface Bucket {
  sessions: number
  totals: ModelTotals
}

function statRow(label: string, bucket: Bucket, decimals: number): string[] {
  return [label, String(bucket.sessions), ...usageCells(bucket.totals, decimals)]
}

export function renderStats(statsDays: number, decimals: number): string {
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - (statsDays - 1))
  const windowed = loadHistory(cutoff.getTime())
  if (windowed === null) return "No usage history recorded yet."
  if (windowed.length === 0) return `No usage recorded in the last ${statsDays} days.`

  const daily = new Map<string, Bucket>()
  const byModel = new Map<string, Bucket>()
  for (const entry of windowed) {
    const day = dayKey(new Date(entry.time))
    const dayBucket = daily.get(day) ?? { sessions: 0, totals: emptyTotals() }
    dayBucket.sessions += 1
    addTotals(dayBucket.totals, entry.totals)
    daily.set(day, dayBucket)
    for (const [id, totals] of Object.entries(entry.models)) {
      const modelBucket = byModel.get(id) ?? { sessions: 0, totals: emptyTotals() }
      modelBucket.sessions += 1
      addTotals(modelBucket.totals, totals)
      byModel.set(id, modelBucket)
    }
  }

  const overall: Bucket = { sessions: windowed.length, totals: emptyTotals() }
  for (const bucket of daily.values()) addTotals(overall.totals, bucket.totals)

  const numeric = [false, true, true, true, true, true, true, true]
  const columns = ["sessions", "input", "output", "cache read", "cache write", "cost", "turns"]

  const dailyRows = [...daily.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, bucket]) => statRow(day, bucket, decimals))
  dailyRows.push(statRow("total", overall, decimals))

  const modelRows = [...byModel.entries()]
    .sort((a, b) => b[1].totals.cost - a[1].totals.cost || a[0].localeCompare(b[0]))
    .map(([id, bucket]) => statRow(id, bucket, decimals))
  modelRows.push(statRow("total", overall, decimals))

  return [
    `Usage stats (last ${statsDays} days, ${windowed.length} sessions)`,
    "",
    "By day",
    renderTable(["date", ...columns], dailyRows, numeric),
    "",
    "By model",
    renderTable(["model", ...columns], modelRows, numeric)
  ].join("\n")
}
