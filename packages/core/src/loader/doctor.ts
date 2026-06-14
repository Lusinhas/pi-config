import type { ResourceCatalogResult } from "./index.ts";
import { DuplicateNameValidator } from "./validators.ts";
import type { ResourceValidationResult } from "./validators.ts";

export class DoctorReport {
  private readonly duplicateNames = new DuplicateNameValidator();

  build(catalog: ResourceCatalogResult, validation: ResourceValidationResult, suiteConfigLines: string[], errors: string[], warnings: string[]): string {
    this.duplicateNames.find(validation.skills, "skill", errors);
    this.duplicateNames.find(validation.prompts, "prompt", errors);
    this.duplicateNames.find(validation.themes, "theme", errors);
    this.duplicateNames.find(validation.agents, "agent", errors);

    const lines: string[] = [];
    lines.push(`pi-config doctor — ${catalog.root}`);
    lines.push(
      `resources: skills ${catalog.skills.length} prompts ${catalog.prompts.length} themes ${catalog.themes.length} agents ${catalog.agents.length}`,
    );
    lines.push("suite.json:");
    lines.push(...suiteConfigLines);

    if (errors.length > 0) {
      lines.push("errors:");

      for (const item of errors) {
        lines.push(`  ${item}`);
      }
    }

    if (warnings.length > 0) {
      lines.push("warnings:");

      for (const item of warnings) {
        lines.push(`  ${item}`);
      }
    }

    const total = catalog.skills.length + catalog.prompts.length + catalog.themes.length + catalog.agents.length;
    lines.push(`summary: ${total} resources checked, ${errors.length} error(s), ${warnings.length} warning(s)`);

    return lines.join("\n");
  }
}
