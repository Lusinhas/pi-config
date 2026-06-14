import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ContextExtension } from "./extension.ts";

export default function context(pi: ExtensionAPI): void {
  new ContextExtension(pi).register();
}
