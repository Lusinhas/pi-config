import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader } from "./config.ts";
import { registerTodos } from "./todos.ts";
import { registerPlan } from "./plan.ts";
import { registerKeywords } from "./keywords.ts";

export class TasksExtension {
  private readonly loader: Loader;

  constructor(private readonly pi: ExtensionAPI) {
    this.loader = new Loader(new URL("../../config.json", import.meta.url), process.cwd());
  }

  register(): void {
    registerTodos(this.pi, this.loader.todos());
    registerPlan(this.pi, this.loader.plan());
    registerKeywords(this.pi, this.loader.keywords());
  }
}
