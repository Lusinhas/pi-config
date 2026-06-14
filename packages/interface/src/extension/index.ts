import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InterfaceExtension } from "./extension.ts";

export default function interface_(pi: ExtensionAPI): void {
  new InterfaceExtension(pi).register();
}
