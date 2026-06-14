import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CoreExtension } from "./extension.ts";

export default function core(pi: ExtensionAPI): void {
  new CoreExtension(pi).register();
}
