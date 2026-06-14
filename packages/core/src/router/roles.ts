import { errorText, isRecord, Models, type AgentModel } from "./models.ts";
import type { RoleTarget } from "./index.ts";

export const ROLE_CUSTOM_TYPE = "router:role";

export interface ApplyResult {
  ok: boolean;
  text: string;
  model?: string;
}

export interface RolePorts {
  registry: unknown;
  currentModel: AgentModel | null | undefined;
  setModel: (model: AgentModel) => Promise<boolean>;
  setThinkingLevel: (level: string) => void;
  emitRole: (role: string, model: string) => void;
  appendEntry: (role: string, model: string) => void;
}

export class RoleMessages {
  #customType: string;

  constructor(customType: string) {
    this.#customType = customType;
  }

  unknownRole(name: string, names: string[]): string {
    if (names.length === 0) {
      return `router: unknown role "${name}" and no roles are configured (add them under router.roles in suite.json)`;
    }

    const lower = name.toLowerCase();
    const close = names.filter(candidate => {
      const other = candidate.toLowerCase();

      return other.includes(lower) || lower.includes(other);
    });

    const hint = close.length > 0 ? ` Close matches: ${close.join(", ")}.` : "";

    return `router: unknown role "${name}". Available: ${names.join(", ")}.${hint}`;
  }

  lastRoleFrom(entries: unknown): string | undefined {
    if (!Array.isArray(entries)) {
      return undefined;
    }

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];

      if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== this.#customType) {
        continue;
      }

      const data = entry.data !== undefined ? entry.data : entry.details;

      if (isRecord(data) && typeof data.role === "string" && data.role.trim() !== "") {
        return data.role;
      }
    }

    return undefined;
  }
}

export class Roles {
  #roles: Record<string, RoleTarget>;
  #messages: RoleMessages;
  #active: string | undefined;

  constructor(roles: Record<string, RoleTarget>) {
    this.#roles = roles;
    this.#messages = new RoleMessages(ROLE_CUSTOM_TYPE);
    this.#active = undefined;
  }

  get active(): string | undefined {
    return this.#active;
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.#roles, name);
  }

  unknownRole(name: string): string {
    return this.#messages.unknownRole(name, Object.keys(this.#roles));
  }

  lastRoleFrom(entries: unknown): string | undefined {
    return this.#messages.lastRoleFrom(entries);
  }

  async applyRole(name: string, ports: RolePorts, persist: boolean): Promise<ApplyResult> {
    const role = this.#roles[name];

    if (!role) {
      return { ok: false, text: this.unknownRole(name) };
    }

    const resolution = Models.resolveIn(await Models.list(ports.registry), role.model);

    if (!resolution.model) {
      const hint =
        resolution.suggestions.length > 0 ? ` Close matches: ${resolution.suggestions.join(", ")}.` : "";

      return {
        ok: false,
        text: `router: role "${name}" points at model "${role.model}", which is not in the model registry.${hint}`
      };
    }

    const modelId = Models.describe(resolution.model);
    let ok = false;

    try {
      ok = await ports.setModel(resolution.model);
    } catch (error) {
      return { ok: false, text: `router: switching to ${modelId} failed: ${errorText(error)}` };
    }

    if (!ok) {
      return { ok: false, text: `router: the agent rejected model ${modelId}` };
    }

    if (role.thinking) {
      try {
        ports.setThinkingLevel(role.thinking);
      } catch {}
    }

    this.#active = name;

    try {
      ports.emitRole(name, modelId);
    } catch {}

    if (persist) {
      try {
        ports.appendEntry(name, modelId);
      } catch {}
    }

    const thinking = role.thinking ? `, thinking ${role.thinking}` : "";

    return { ok: true, text: `router: role "${name}" active (${modelId}${thinking})`, model: modelId };
  }

  async renderRoles(ports: RolePorts): Promise<string> {
    const names = Object.keys(this.#roles);

    if (names.length === 0) {
      return "router: no roles configured (add them under router.roles in suite.json)";
    }

    const models = await Models.list(ports.registry);
    const width = names.reduce((max, name) => Math.max(max, name.length), 0);
    const lines: string[] = [];

    for (const name of names) {
      const role = this.#roles[name];
      const resolution = Models.resolveIn(models, role.model);
      const target = resolution.model ? Models.describe(resolution.model) : `${role.model} (not in registry)`;
      const thinking = role.thinking ? `  thinking=${role.thinking}` : "";
      const marker = name === this.#active ? "*" : " ";

      lines.push(`${marker} ${name.padEnd(width)}  ${target}${thinking}`);
    }

    lines.push(`Current model: ${Models.describe(ports.currentModel)}`);

    return `Roles (* = active, /role <name> switches):\n${lines.join("\n")}`;
  }
}
