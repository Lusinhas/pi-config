export interface Rule {
  tool: string;
  pattern?: string;
}

export interface SessionRule extends Rule {
  prefix?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class RuleText {
  static safeStringify(value: unknown): string {
    try {
      const text = JSON.stringify(value);

      return typeof text === "string" ? text : String(value);
    } catch {
      return String(value);
    }
  }

  static format(rule: SessionRule): string {
    const parts = [`tool=${rule.tool}`];

    if (rule.pattern !== undefined) {
      parts.push(`pattern="${rule.pattern}"`);
    }

    if (rule.prefix === true) {
      parts.push("(prefix)");
    }

    return parts.join(" ");
  }
}

export class RuleSanitizer {
  static rules(value: unknown): Rule[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const rules: Rule[] = [];

    for (const item of value) {
      const rule = RuleSanitizer.sessionRule(item);

      if (rule) {
        rules.push({ tool: rule.tool, ...(rule.pattern === undefined ? {} : { pattern: rule.pattern }) });
      }
    }

    return rules;
  }

  static sessionRule(value: unknown): SessionRule | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    const tool = value.tool;

    if (typeof tool !== "string" || tool.trim().length === 0) {
      return undefined;
    }

    const rule: SessionRule = { tool: tool.trim() };

    if (typeof value.pattern === "string" && value.pattern.trim().length > 0) {
      rule.pattern = value.pattern;
    }

    if (value.prefix === true) {
      rule.prefix = true;
    }

    return rule;
  }
}
