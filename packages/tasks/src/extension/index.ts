import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TasksExtension } from "./extension.ts";

export default function tasks(pi: ExtensionAPI): void {
  new TasksExtension(pi).register();
}
