import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AuthExtension } from "./extension.ts";

export default function auth(pi: ExtensionAPI): void {
  new AuthExtension(pi).register();
}
