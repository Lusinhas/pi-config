import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { loadAgentsConfig } from "./config.ts"
import { SubagentsRegistrar } from "./subagents.ts"
import { WorkflowsRegistrar } from "./workflows.ts"
import { GoalsRegistrar } from "./goals.ts"

export class AgentsExtension {
  private readonly pi: ExtensionAPI

  constructor(pi: ExtensionAPI) {
    this.pi = pi
  }

  register(): void {
    const pi = this.pi
    const config = loadAgentsConfig()
    const subagents = new SubagentsRegistrar(pi, config.subagents)
    const workflows = new WorkflowsRegistrar(pi, config.workflows, subagents.runner)
    const goals = new GoalsRegistrar(pi, config.goals)

    subagents.register()
    workflows.register()
    goals.register()

    pi.on("session_shutdown", () => {
      workflows.shutdown()
    })
  }
}
