import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgesExtension } from "./extension.ts";

export default function bridges(pi: ExtensionAPI): void {
  new BridgesExtension(pi).register();
}
