import { SessionManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Consolidator } from "../memory/consolidate.ts";
import { Store as MemoryStore } from "../memory/index.ts";
import { Store as SessionsStore } from "../sessions/index.ts";
import { Search } from "../sessions/search.ts";
import { RuleDiscovery } from "../rules/formats.ts";
import { RulesEngine } from "../rules/index.ts";
import { GlobMatcher, BashPaths, PathResolver, TouchTracker } from "../rules/matcher.ts";
import { CompactionRegistrar } from "./compaction.ts";
import { ConfigLoader } from "./config.ts";
import { MemoryRegistrar } from "./memory.ts";
import { RulesRegistrar } from "./rules.ts";
import { SessionsRegistrar } from "./sessions.ts";
import { Viewer } from "./viewer.ts";

export class ContextExtension {
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  register(): void {
    const config = new ConfigLoader();

    this.registerMemory(config);
    this.registerCompaction(config);
    this.registerSessions(config);
    this.registerRules(config);
  }

  private registerMemory(config: ConfigLoader): void {
    const cfg = config.memory();
    const store = new MemoryStore((path, run) => withFileMutationQueue(path, run));
    const consolidator = new Consolidator(store);

    new MemoryRegistrar(this.pi, cfg, store, consolidator).register();
  }

  private registerCompaction(config: ConfigLoader): void {
    new CompactionRegistrar(this.pi, config.compaction()).register();
  }

  private registerSessions(config: ConfigLoader): void {
    const store = new SessionsStore((cwd, all) => (all ? SessionManager.listAll() : SessionManager.list(cwd)));
    const search = new Search(store);
    const viewer = new Viewer();

    new SessionsRegistrar(this.pi, config.sessions(), store, search, viewer).register();
  }

  private registerRules(config: ConfigLoader): void {
    const settings = config.rules();
    const resolver = new PathResolver();
    const tracker = new TouchTracker(resolver, new BashPaths(resolver));
    const engine = new RulesEngine(settings, new RuleDiscovery(settings.formats), new GlobMatcher());

    new RulesRegistrar(this.pi, engine, tracker).register();
  }
}
