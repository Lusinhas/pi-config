import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clip, indexPath, memoryDir, type MemoryConfig } from "./store";

export function registerInject(pi: ExtensionAPI, cfg: MemoryConfig): void {
  pi.on("before_agent_start", async (event, ctx) => {
    let raw: string;
    try {
      raw = await readFile(indexPath(memoryDir(ctx.cwd)), "utf8");
    } catch {
      return undefined;
    }
    const index = raw.trim();
    if (index.length === 0) return undefined;
    const header =
      'Persistent project memory index (notes saved in earlier sessions; call the memory tool with op "recall" and a topic to read the full notes):';
    return { systemPrompt: `${event.systemPrompt}\n\n${header}\n${clip(index, cfg.injectBudget)}` };
  });
}
