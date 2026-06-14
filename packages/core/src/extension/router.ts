import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import {
  Config,
  Effort,
  FallbackEngine,
  ProfileManager,
  Roles,
  ROLE_CUSTOM_TYPE
} from "../router/index.ts";
import type {
  AgentModel,
  EffortLevel,
  EffortPorts,
  FallbackPorts,
  ProfilePorts,
  ProviderResponseEvent,
  RolePorts,
  ThinkingLevel
} from "../router/index.ts";
import { isRecord } from "../router/index.ts";
import type { CoreConfig } from "./extension.ts";

class RouterPorts {
  #pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
  }

  notify(ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error"): void {
    if (ctx.hasUI) {
      try {
        ctx.ui.notify(text, kind);

        return;
      } catch {}
    }

    console.log(text);
  }

  role(ctx: ExtensionContext): RolePorts {
    const pi = this.#pi;

    return {
      registry: ctx.modelRegistry,
      currentModel: ctx.model as AgentModel | null | undefined,
      setModel: (model: AgentModel) => pi.setModel(model as never),
      setThinkingLevel: (level: string) => pi.setThinkingLevel(level as never),
      emitRole: (role: string, model: string) => pi.events.emit("piconfig:role", { role, model }),
      appendEntry: (role: string, model: string) => pi.appendEntry(ROLE_CUSTOM_TYPE, { role, model })
    };
  }

  effort(): EffortPorts {
    const pi = this.#pi;

    return {
      getThinkingLevel: () => pi.getThinkingLevel(),
      setThinkingLevel: (level: ThinkingLevel) => pi.setThinkingLevel(level as never)
    };
  }

  fallback(ctx: ExtensionContext): FallbackPorts {
    const pi = this.#pi;

    return {
      registry: ctx.modelRegistry,
      currentModel: ctx.model as AgentModel | null | undefined,
      hasUI: ctx.hasUI,
      setModel: (model: AgentModel) => pi.setModel(model as never),
      confirm: (title: string, message: string) => ctx.ui.confirm(title, message),
      notify: (text, kind) => this.notify(ctx, text, kind)
    };
  }

  profile(ctx: ExtensionContext): ProfilePorts {
    const pi = this.#pi;

    return {
      registry: ctx.modelRegistry,
      currentModel: ctx.model as AgentModel | null | undefined,
      hasUI: ctx.hasUI,
      cwd: ctx.cwd,
      home: homedir(),
      setModel: (model: AgentModel) => pi.setModel(model as never),
      setThinkingLevel: (level: ThinkingLevel) => pi.setThinkingLevel(level as never),
      getThinkingLevel: () => pi.getThinkingLevel(),
      getActiveTools: () => pi.getActiveTools(),
      setActiveTools: (tools: string[]) => pi.setActiveTools(tools as never),
      getAllTools: () => pi.getAllTools(),
      setTheme: (theme: string) => ctx.ui.setTheme(theme),
      notify: (text, kind) => this.notify(ctx, text, kind)
    };
  }
}

export class RouterRegistrar {
  #pi: ExtensionAPI;
  #config: CoreConfig;

  constructor(pi: ExtensionAPI, config: CoreConfig) {
    this.#pi = pi;
    this.#config = config;
  }

  register(): void {
    const sources = this.#config.load(process.cwd());
    const shippedRouter = isRecord(sources.shipped) ? sources.shipped.router : undefined;
    const config = Config.fromRaw(shippedRouter, sources.global, sources.project);

    const roles = new Roles(config.roles);
    const profiles = new ProfileManager(config.profiles);
    const fallback = new FallbackEngine(config.fallback);
    const effort = new Effort(config.maxBudgetTokens);
    const ports = new RouterPorts(this.#pi);

    this.#registerEvents(ports, roles, profiles, fallback, effort);
    this.#registerCommands(ports, roles, profiles, effort);
  }

  #registerEvents(
    ports: RouterPorts,
    roles: Roles,
    profiles: ProfileManager,
    fallback: FallbackEngine,
    effort: Effort
  ): void {
    this.#registerRoleRestore(ports, roles);
    this.#registerProfileFlag(ports, profiles);

    if (fallback.enabled) {
      this.#registerFallback(ports, fallback);
    }

    this.#registerEffortEvents(effort);
  }

  #registerRoleRestore(ports: RouterPorts, roles: Roles): void {
    const pi = this.#pi;

    pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
      const entries = ((): unknown => {
        try {
          return ctx.sessionManager.getEntries();
        } catch {
          return undefined;
        }
      })();
      const name = roles.lastRoleFrom(entries);

      if (name && roles.has(name)) {
        const result = await roles.applyRole(name, ports.role(ctx), false);

        if (result.ok) {
          if (ctx.hasUI) {
            ports.notify(ctx, `router: restored role "${name}" (${result.model})`, "info");
          }
        } else if (ctx.hasUI) {
          ports.notify(ctx, `router: could not restore role "${name}" — ${result.text}`, "warning");
        }
      }
    });
  }

  #registerProfileFlag(ports: RouterPorts, profiles: ProfileManager): void {
    const pi = this.#pi;

    pi.registerFlag("profile", {
      description: "Apply the named router profile (model, thinking, theme, tools, style) at session start",
      type: "string",
      default: ""
    });

    pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
      profiles.reset();
      const value = pi.getFlag("profile");

      if (typeof value !== "string") {
        return;
      }

      const flagged = value.trim();

      if (flagged === "") {
        return;
      }

      await profiles.apply(flagged, ports.profile(ctx));
    });
  }

  #registerFallback(ports: RouterPorts, fallback: FallbackEngine): void {
    const pi = this.#pi;

    pi.on("session_start", () => {
      fallback.onSessionStart();
    });

    pi.on("model_select", (event: { model?: unknown }) => {
      fallback.onModelSelect(event?.model);
    });

    pi.on("after_provider_response", async (event: ProviderResponseEvent, ctx: ExtensionContext) => {
      await fallback.recordResponse(event, ports.fallback(ctx), Date.now());
    });

    pi.on("turn_end", async (_event: unknown, ctx: ExtensionContext) => {
      await fallback.onTurnEnd(ports.fallback(ctx), Date.now());
    });
  }

  #registerEffortEvents(effort: Effort): void {
    const pi = this.#pi;

    pi.on("thinking_level_select", () => {
      effort.onThinkingSelect();
    });

    pi.on("before_provider_request", (event: { payload?: unknown }) => {
      return effort.rewriteRequest(event?.payload);
    });
  }

  #registerCommands(ports: RouterPorts, roles: Roles, profiles: ProfileManager, effort: Effort): void {
    this.#registerRole(ports, roles);
    this.#registerProfile(ports, profiles);
    this.#registerEffort(ports, effort);
  }

  #registerRole(ports: RouterPorts, roles: Roles): void {
    this.#pi.registerCommand("role", {
      description: "Switch model role (/role <name>) or list configured roles with the active one marked",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const name = args.trim();

        if (name === "") {
          ports.notify(ctx, await roles.renderRoles(ports.role(ctx)), "info");

          return;
        }

        const result = await roles.applyRole(name, ports.role(ctx), true);
        ports.notify(ctx, result.text, result.ok ? "info" : "error");
      }
    });
  }

  #registerProfile(ports: RouterPorts, profiles: ProfileManager): void {
    this.#pi.registerCommand("profile", {
      description:
        "Apply a named profile (/profile <name>), list profiles (/profile), or revert to the session snapshot (/profile off)",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const name = args.trim();

        if (name === "") {
          ports.notify(ctx, profiles.render(), "info");

          return;
        }

        if (name.toLowerCase() === "off") {
          await profiles.revert(ports.profile(ctx));

          return;
        }

        await profiles.apply(name, ports.profile(ctx));
      }
    });
  }

  #registerEffort(ports: RouterPorts, effort: Effort): void {
    this.#pi.registerCommand("effort", {
      description:
        "Show or set the model's reasoning effort (off | minimal | low | medium | high | xhigh | max, or up/down to step); max sits above xhigh and forces the provider's thinking budget to its ceiling",
      getArgumentCompletions: (prefix: string) => effort.completions(prefix),
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const requested = (args ?? "").trim().toLowerCase();
        const tell = (text: string, level: "info" | "error"): void => {
          if (ctx.hasUI) {
            ctx.ui.notify(text, level);
          }
        };

        if (requested === "") {
          tell(effort.summary(ports.effort().getThinkingLevel), "info");

          return;
        }

        let target: EffortLevel | undefined;

        if (requested === "up" || requested === "down") {
          const current = effort.currentLevel(ports.effort().getThinkingLevel);
          const next = effort.step(current, requested);

          if (next === undefined) {
            tell(`effort: already at ${current} (${requested === "up" ? "maximum" : "minimum"})`, "info");

            return;
          }

          target = next;
        } else if (requested === "max") {
          target = "max";
        } else {
          target =
            Effort.LADDER.includes(requested as EffortLevel) && requested !== "max"
              ? (requested as EffortLevel)
              : undefined;
        }

        if (target === undefined) {
          tell(`effort: unknown level "${requested}" (valid: ${Effort.LADDER.join(", ")}, up, down)`, "error");

          return;
        }

        if (!effort.apply(target, ports.effort())) {
          tell(`effort: the current model does not accept thinking level ${target === "max" ? "xhigh" : target}`, "error");

          return;
        }

        tell(`effort: ${target} (${effort.describeLevel(target)})`, "info");
      }
    });
  }
}
