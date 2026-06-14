import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EditingExtension } from "./extension.ts";

export default function editing(pi: ExtensionAPI): void {
  new EditingExtension(pi).register();
}
