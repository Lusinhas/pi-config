import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BatchExtension } from "./extension.ts";

export default function batch(pi: ExtensionAPI): void {
  new BatchExtension(pi).register();
}
