import { isEmptyTotals } from "./index.ts"
import type { SessionSnapshot } from "./index.ts"
import { loadHistory } from "./store.ts"
import { renderTable, usageCells } from "./table.ts"
import { aggregate, cutoffMs, statRow } from "./aggregate.ts"

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

export function renderStats(statsDays: number, decimals: number): string {
  const windowed = loadHistory(cutoffMs(statsDays))

  if (windowed === null) return "No usage history recorded yet."

  if (windowed.length === 0) return `No usage recorded in the last ${statsDays} days.`

  const { daily, byModel, overall } = aggregate(windowed)
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
