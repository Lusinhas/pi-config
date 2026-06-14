import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { AgentsExtension } from "./extension.ts"

export default function agents(pi: ExtensionAPI): void {
  new AgentsExtension(pi).register()
}
