import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GuardExtension } from "./extension.ts";

export default function guard(pi: ExtensionAPI): void {
  new GuardExtension(pi).register();
}
