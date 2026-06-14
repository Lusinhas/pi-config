import { readFileSync } from "node:fs";
import { asThinking, isRecord, type ThinkingLevel } from "./models.ts";

export interface RoleTarget {
  model: string;
  thinking?: ThinkingLevel;
}

export interface FallbackConfig {
  enabled: boolean;
  threshold: number;
  failWindowSec: number;
  restoreAfterMin: number;
  chains: Record<string, string[]>;
}

export interface ProfileSpec {
  model?: string;
  thinking?: ThinkingLevel;
  theme?: string;
  tools?: string[];
  style?: string;
}

export interface RouterConfig {
  roles: Record<string, RoleTarget>;
  fallback: FallbackConfig;
  profiles: Record<string, ProfileSpec>;
  maxBudgetTokens: number;
}

const FALLBACK_DEFAULTS: FallbackConfig = {
  enabled: true,
  threshold: 2,
  failWindowSec: 120,
  restoreAfterMin: 10,
  chains: {}
};

const DEFAULT_MAX_BUDGET_TOKENS = 100000;

const MIN_BUDGET_TOKENS = 1024;

const MAX_WINDOW_SEC = 86400;

const MAX_RESTORE_MIN = 1440;

const MAX_THRESHOLD = 1000;

export class Config {
  static readonly FALLBACK_DEFAULTS = FALLBACK_DEFAULTS;

  static readonly DEFAULT_MAX_BUDGET_TOKENS = DEFAULT_MAX_BUDGET_TOKENS;

  static readonly MIN_BUDGET_TOKENS = MIN_BUDGET_TOKENS;

  static readonly MAX_WINDOW_SEC = MAX_WINDOW_SEC;

  static readonly MAX_RESTORE_MIN = MAX_RESTORE_MIN;

  static readonly MAX_THRESHOLD = MAX_THRESHOLD;

  static deepMerge(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
    if (!isRecord(override)) {
      return base;
    }

    const out: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(override)) {
      const existing = out[key];

      if (isRecord(existing) && isRecord(value)) {
        out[key] = Config.deepMerge(existing, value);
      } else if (value !== undefined) {
        out[key] = value;
      }
    }

    return out;
  }

  static readJson(path: string | URL): unknown {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }

  static overlayFrom(source: unknown): unknown {
    if (isRecord(source)) {
      return source.router;
    }

    return undefined;
  }

  static positiveBounded(value: unknown, fallback: number, max: number): number {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.min(value, max);
    }

    return fallback;
  }

  static cloneFallback(value: FallbackConfig): FallbackConfig {
    const chains: Record<string, string[]> = {};

    for (const [pattern, chain] of Object.entries(value.chains)) {
      chains[pattern] = [...chain];
    }

    return { ...value, chains };
  }

  static parseRoles(raw: unknown): Record<string, RoleTarget> {
    const roles: Record<string, RoleTarget> = {};

    if (!isRecord(raw)) {
      return roles;
    }

    for (const [name, value] of Object.entries(raw)) {
      if (name.trim() === "") {
        continue;
      }

      if (typeof value === "string" && value.trim() !== "") {
        roles[name] = { model: value.trim() };
      } else if (isRecord(value) && typeof value.model === "string" && value.model.trim() !== "") {
        const thinking = asThinking(value.thinking);

        roles[name] = thinking ? { model: value.model.trim(), thinking } : { model: value.model.trim() };
      }
    }

    return roles;
  }

  static parseFallback(raw: unknown, base: FallbackConfig = FALLBACK_DEFAULTS): FallbackConfig {
    const defaults = base;

    if (!isRecord(raw)) {
      return Config.cloneFallback(defaults);
    }

    const chains: Record<string, string[]> = {};

    if (isRecord(raw.chains)) {
      for (const [pattern, value] of Object.entries(raw.chains)) {
        if (pattern.trim() === "" || !Array.isArray(value)) {
          continue;
        }

        const chain = value
          .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
          .map(entry => entry.trim());

        if (chain.length > 0) {
          chains[pattern.trim()] = chain;
        }
      }
    }

    const threshold = Math.floor(Config.positiveBounded(raw.threshold, defaults.threshold, MAX_THRESHOLD));

    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled,
      threshold: Math.max(1, threshold),
      failWindowSec: Config.positiveBounded(raw.failWindowSec, defaults.failWindowSec, MAX_WINDOW_SEC),
      restoreAfterMin: Config.positiveBounded(raw.restoreAfterMin, defaults.restoreAfterMin, MAX_RESTORE_MIN),
      chains
    };
  }

  static parseProfiles(raw: unknown): Record<string, ProfileSpec> {
    const profiles: Record<string, ProfileSpec> = {};

    if (!isRecord(raw)) {
      return profiles;
    }

    for (const [name, value] of Object.entries(raw)) {
      if (name.trim() === "" || name.trim().toLowerCase() === "off" || !isRecord(value)) {
        continue;
      }

      const spec: ProfileSpec = {};

      if (typeof value.model === "string" && value.model.trim() !== "") {
        spec.model = value.model.trim();
      }

      const thinking = asThinking(value.thinking);

      if (thinking) {
        spec.thinking = thinking;
      }

      if (typeof value.theme === "string" && value.theme.trim() !== "") {
        spec.theme = value.theme.trim();
      }

      if (Array.isArray(value.tools)) {
        spec.tools = value.tools
          .filter((tool): tool is string => typeof tool === "string" && tool.trim() !== "")
          .map(tool => tool.trim());
      }

      if (typeof value.style === "string" && value.style.trim() !== "") {
        spec.style = value.style.trim();
      }

      if (Object.keys(spec).length > 0) {
        profiles[name] = spec;
      }
    }

    return profiles;
  }

  static maxBudgetTokens(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value) && value >= MIN_BUDGET_TOKENS) {
      return Math.floor(value);
    }

    return DEFAULT_MAX_BUDGET_TOKENS;
  }

  static fromRaw(shipped: unknown, global: unknown, project: unknown): RouterConfig {
    let merged: Record<string, unknown> = {};

    merged = Config.deepMerge(merged, shipped);
    merged = Config.deepMerge(merged, Config.overlayFrom(global));
    merged = Config.deepMerge(merged, Config.overlayFrom(project));

    const shippedFallback = isRecord(shipped) ? Config.parseFallback(shipped.fallback) : FALLBACK_DEFAULTS;

    return {
      roles: Config.parseRoles(merged.roles),
      fallback: Config.parseFallback(merged.fallback, shippedFallback),
      profiles: Config.parseProfiles(merged.profiles),
      maxBudgetTokens: Config.maxBudgetTokens(merged.maxBudgetTokens)
    };
  }
}

export {
  Models,
  ModelCatalog,
  THINKING_LEVELS,
  asThinking,
  isRecord,
  errorText,
  type ThinkingLevel,
  type AgentModel,
  type RegistryLike,
  type Resolution
} from "./models.ts";
export { Roles, RoleMessages, ROLE_CUSTOM_TYPE, type ApplyResult, type RolePorts } from "./roles.ts";
export {
  Effort,
  Ladder,
  RequestRewriter,
  LADDER,
  DESCRIPTIONS,
  type EffortLevel,
  type EffortCompletion,
  type EffortPorts
} from "./effort.ts";
export {
  FallbackEngine,
  FallbackStatus,
  type ActiveFallback,
  type FailureRecord,
  type FallbackPorts,
  type ProviderResponseEvent
} from "./fallback.ts";
export {
  ProfileManager,
  ProfileStore,
  type ProfilePorts,
  type Snapshot
} from "./profiles.ts";
