import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { StyleStore } from "../styles/catalog.ts";
import { FrontmatterParser, StyleFileParser } from "../styles/parse.ts";
import { ActivePersister } from "../styles/persist.ts";
import { FsDirectoryReader } from "../styles/reader.ts";
import { Renderer } from "../styles/render.ts";
import { StyleEngine } from "../styles/index.ts";
import { SuiteConfigSource, SuiteFileIo } from "./config.ts";

export class StylesRegistrar {
  readonly #pi: ExtensionAPI;
  readonly #engine: StyleEngine;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;

    const fileParser = new StyleFileParser(new FrontmatterParser());
    const reader = new FsDirectoryReader();
    const presetDir = fileURLToPath(new URL("../../presets", import.meta.url));
    const store = new StyleStore(fileParser, reader, presetDir);
    const configSource = new SuiteConfigSource();

    this.#engine = new StyleEngine(
      store,
      new Renderer(),
      new ActivePersister(),
      new SuiteFileIo(),
      configSource,
      configSource.load(),
    );
  }

  register(): void {
    const pi = this.#pi;
    const engine = this.#engine;

    pi.on("session_start", () => {
      engine.reloadConfig();
    });

    pi.on("resources_discover", (event: { reason: unknown }) => {
      engine.onResourcesDiscover(event.reason);

      return undefined;
    });

    pi.on("before_agent_start", (event: { systemPrompt: unknown }) => engine.addendum(event.systemPrompt));

    pi.registerCommand("style", {
      description: 'Select the active output style ("/style <name>" applies directly, "/style off" disables)',
      getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null =>
        engine.completions(argumentPrefix),
      handler: async (args, ctx): Promise<void> => {
        engine.refreshCatalog();

        const notices = engine.notices();

        if (notices !== null && ctx.hasUI) {
          ctx.ui.notify(notices, "warning");
        }

        const requested = typeof args === "string" ? args.trim() : "";

        if (requested !== "") {
          const notice = engine.apply(requested);

          if (ctx.hasUI) {
            ctx.ui.notify(notice.message, notice.level);
          }

          return;
        }

        if (!ctx.hasUI) {
          return;
        }

        const menu = engine.menu();
        const choice = await ctx.ui.select("Output style", menu.options);
        const notice = engine.applyMenuChoice(menu, choice);

        if (notice !== null) {
          ctx.ui.notify(notice.message, notice.level);
        }
      },
    });
  }
}
