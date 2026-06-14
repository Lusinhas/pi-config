import type { Catalog, StyleStore } from "./catalog.ts";
import { Config, type StylesConfig } from "./config.ts";
import type { ActivePersister } from "./persist.ts";
import { NoticeFactory, type CompletionItem, type Notice, type Renderer, type SelectMenu } from "./render.ts";

export type { Notice, NoticeLevel, CompletionItem, SelectMenu } from "./render.ts";

export interface Addendum {
  systemPrompt: string;
}

export interface SuiteRead {
  ok: boolean;
  content: string | null;
}

export interface SuiteFile {
  read(): SuiteRead;
  write(content: string): boolean;
}

export interface ConfigSource {
  load(): StylesConfig;
}

export class StyleEngine {
  private active: string;
  private userDir: string;
  private catalog: Catalog;
  private readonly notices_ = new NoticeFactory();

  constructor(
    private readonly store: StyleStore,
    private readonly renderer: Renderer,
    private readonly persister: ActivePersister,
    private readonly suite: SuiteFile,
    private readonly configSource: ConfigSource,
    initial: StylesConfig,
  ) {
    this.active = initial.active;
    this.userDir = Config.expandHome(initial.userDir);
    this.catalog = this.store.discover(this.userDir);
  }

  reloadConfig(): void {
    const fresh = this.configSource.load();
    this.active = fresh.active;
    this.userDir = Config.expandHome(fresh.userDir);
    this.refreshCatalog();
  }

  refreshCatalog(): void {
    this.catalog = this.store.discover(this.userDir);
  }

  onResourcesDiscover(reason: unknown): void {
    if (reason === "reload") {
      this.refreshCatalog();
    }
  }

  addendum(systemPrompt: unknown): Addendum | undefined {
    if (this.active.toLowerCase() === "off") {
      return undefined;
    }

    const style = this.catalog.get(this.active);

    if (style === undefined) {
      return undefined;
    }

    const incoming = typeof systemPrompt === "string" ? systemPrompt : "";

    return { systemPrompt: this.renderer.buildAddendum(style, incoming) };
  }

  completions(argumentPrefix: string): CompletionItem[] | null {
    return this.renderer.completions(this.catalog, argumentPrefix);
  }

  notices(): string | null {
    return this.renderer.formatNotices(this.catalog, this.active);
  }

  menu(): SelectMenu {
    return this.renderer.selectMenu(this.catalog, this.active);
  }

  apply(requested: string): Notice {
    const key = requested.toLowerCase();

    if (key === "off") {
      this.active = "off";
      const persisted = this.persist("off");

      return this.notices_.disabled(persisted);
    }

    const style = this.catalog.get(key);

    if (style === undefined) {
      const available = this.catalog.values().map((entry) => entry.name).join(", ");

      return this.notices_.unknown(requested, available);
    }

    this.active = style.name;
    const persisted = this.persist(style.name);

    return this.notices_.applied(style, persisted);
  }

  applyMenuChoice(menu: SelectMenu, choice: string | undefined): Notice | null {
    if (choice === undefined) {
      return null;
    }

    const index = menu.options.indexOf(choice);

    if (index === -1) {
      return null;
    }

    return this.apply(menu.values[index]);
  }

  private persist(active: string): boolean {
    const read = this.suite.read();

    if (!read.ok) {
      return false;
    }

    const result = this.persister.build(read.content, active);

    if (!result.ok) {
      return false;
    }

    return this.suite.write(result.content);
  }
}
