import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Config as SubagentsConfigLoader } from "../subagents/config.ts"
import type { SubagentsConfig } from "../subagents/config.ts"
import { Config as WorkflowsConfigLoader } from "../workflows/index.ts"
import type { WorkflowsConfig } from "../workflows/index.ts"
import { Config as GoalsConfigLoader } from "../goals/config.ts"
import type { GoalsConfig } from "../goals/config.ts"

export interface AgentsConfig {
  subagents: SubagentsConfig
  workflows: WorkflowsConfig
  goals: GoalsConfig
}

interface RootSections {
  subagents: Record<string, unknown> | undefined
  workflows: Record<string, unknown> | undefined
  goals: Record<string, unknown> | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readJsonFile(path: string | URL): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))

    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function section(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  if (source && isRecord(source[key])) {
    return source[key] as Record<string, unknown>
  }

  return undefined
}

function rootSections(): RootSections {
  const shipped = readJsonFile(new URL("../../config.json", import.meta.url))

  return {
    subagents: section(shipped, "subagents"),
    workflows: section(shipped, "workflows"),
    goals: section(shipped, "goals")
  }
}

function overrideLayers(): Record<string, unknown>[] {
  const files = [join(homedir(), ".pi", "agent", "suite.json"), join(process.cwd(), ".pi", "suite.json")]
  const layers: Record<string, unknown>[] = []

  for (const file of files) {
    const parsed = readJsonFile(file)

    if (parsed) {
      layers.push(parsed)
    }
  }

  return layers
}

export function loadAgentsConfig(): AgentsConfig {
  const root = rootSections()
  const overrides = overrideLayers()
  const subagents = SubagentsConfigLoader.fromLayers(root.subagents, overrides[0], overrides[1])
  const workflowsLayers: unknown[] = []

  if (root.workflows) {
    workflowsLayers.push(root.workflows)
  }

  for (const layer of overrides) {
    const sub = WorkflowsConfigLoader.section(layer)

    if (sub !== undefined) {
      workflowsLayers.push(sub)
    }
  }

  const workflows = new WorkflowsConfigLoader(workflowsLayers[0], ...workflowsLayers.slice(1)).value
  const goalsLayers: unknown[] = []

  if (root.goals) {
    goalsLayers.push(root.goals)
  }

  for (const layer of overrides) {
    const sub = GoalsConfigLoader.section(layer)

    if (sub !== undefined) {
      goalsLayers.push(sub)
    }
  }

  const goals = new GoalsConfigLoader(goalsLayers).values

  return { subagents, workflows, goals }
}
