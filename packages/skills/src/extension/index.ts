import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SkillsExtension } from "./extension.ts";

export default function skills(pi: ExtensionAPI): void {
  new SkillsExtension(pi).register();
}
