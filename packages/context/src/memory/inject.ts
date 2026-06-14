import { Text } from "./text.ts";

const HEADER =
  'Persistent project memory index (notes saved in earlier sessions; call the memory tool with op "recall" and a topic to read the full notes):';

export class MemoryInjector {
  static readonly header = HEADER;

  render(rawIndex: string, injectBudget: number): string | undefined {
    const index = rawIndex.trim();

    if (index.length === 0) {
      return undefined;
    }

    return `${HEADER}\n${Text.clip(index, injectBudget)}`;
  }

  suffix(systemPrompt: string, rawIndex: string, injectBudget: number): string | undefined {
    const block = this.render(rawIndex, injectBudget);

    if (block === undefined) {
      return undefined;
    }

    return `${systemPrompt}\n\n${block}`;
  }
}
