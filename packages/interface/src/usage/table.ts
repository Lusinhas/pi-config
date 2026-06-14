import { toCount } from "./index.ts"
import type { ModelTotals } from "./index.ts"

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

export function renderTable(headers: string[], rows: string[][], numeric: boolean[]): string {
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

export function usageCells(totals: ModelTotals, decimals: number): string[] {
  return [
    humanTokens(totals.input),
    humanTokens(totals.output),
    humanTokens(totals.cacheRead),
    humanTokens(totals.cacheWrite),
    formatCost(totals.cost, decimals),
    String(totals.turns)
  ]
}
