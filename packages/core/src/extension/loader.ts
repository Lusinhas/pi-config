import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ResourceCatalog } from "../loader/index.ts";
import { DoctorReport } from "../loader/doctor.ts";
import { ResourceContentValidator, ResourceIssueFormatter, SuiteConfigValidator } from "../loader/validators.ts";
import { SetupPlanner, SuiteFile } from "../loader/setup.ts";

export class LoaderRegistrar {
  #pi: ExtensionAPI;
  #catalog: ResourceCatalog;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
    this.#catalog = new ResourceCatalog();
  }

  register(): void {
    this.#registerDoctor();
    this.#registerSetup();
  }

  #registerDoctor(): void {
    const catalog = this.#catalog;

    this.#pi.registerCommand("doctor", {
      description: "Check explicit pi-config package resources, agents, and suite.json files for problems",
      handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
        const resources = catalog.load();
        const errors: string[] = [];
        const warnings: string[] = [];
        const formatter = new ResourceIssueFormatter();

        for (const issue of resources.errors) {
          errors.push(formatter.format(issue));
        }

        for (const issue of resources.warnings) {
          warnings.push(formatter.format(issue));
        }

        const validation = new ResourceContentValidator(resources.root, errors, warnings).validate(resources);
        const suiteConfigLines = new SuiteConfigValidator().validate(ctx.cwd, errors);
        const report = new DoctorReport().build(resources, validation, suiteConfigLines, errors, warnings);
        const kind = errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "info";

        if (ctx.hasUI) {
          ctx.ui.notify(report, kind);
        } else {
          console.log(report);
        }
      }
    });
  }

  #registerSetup(): void {
    const catalog = this.#catalog;
    const planner = new SetupPlanner();
    const target = join(homedir(), ".pi", "agent", "suite.json");

    this.#pi.registerCommand("setup", {
      description: "First-run wizard: pick a theme and default approval mode",
      handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
        if (!ctx.hasUI) {
          console.log(
            `/setup needs the interactive TUI; this session has no UI. Start pi in TUI mode and run /setup again, or set "theme" in ~/.pi/agent/settings.json and edit ${target} by hand using section "permissions".`
          );

          return;
        }

        const resources = catalog.load();
        const appliedTheme = await this.#pickTheme(ctx, planner, resources.themes);

        if (appliedTheme === null) {
          return;
        }

        const modePick = await ctx.ui.select(
          "Default approval mode — ask: confirm every risky tool, auto: a judge model approves safe actions and asks otherwise, write: auto-approve file edits but confirm commands, yolo: never ask",
          ["ask", "auto", "write", "yolo", "skip"]
        );

        if (modePick === undefined) {
          ctx.ui.notify("Setup cancelled; nothing was written.", "warning");

          return;
        }

        const chosenMode = modePick === "skip" ? undefined : modePick;
        const suiteFile = new SuiteFile(target);
        const existing = suiteFile.readExisting();

        if (!existing.valid) {
          const overwrite = await ctx.ui.confirm(
            "Invalid suite.json",
            `${target} is not a valid JSON object. Overwrite it with fresh setup values?`
          );

          if (!overwrite) {
            ctx.ui.notify(`Left ${target} untouched; fix its JSON and rerun /setup.`, "warning");

            return;
          }
        }

        const result = planner.nextSuite(existing.valid ? existing.value : {}, chosenMode);

        if (result.written.length === 0) {
          const notes = [...result.kept];

          if (appliedTheme !== undefined) {
            notes.unshift(`theme "${appliedTheme}" applied and saved to settings.json`);
          }

          const detail = notes.length > 0 ? ` (${notes.join("; ")})` : "";
          ctx.ui.notify(`Nothing to change; ${target} left as is${detail}.`, "info");

          return;
        }

        const writeError = suiteFile.write(result.next);

        if (writeError !== undefined) {
          ctx.ui.notify(`Failed to write ${target}: ${writeError}`, "error");

          return;
        }

        const lines = [`Setup complete — wrote ${target}`];

        if (appliedTheme !== undefined) {
          lines.push(`  theme = "${appliedTheme}" (applied and saved to settings.json)`);
        }

        for (const item of result.written) {
          lines.push(`  ${item}`);
        }

        for (const item of result.kept) {
          lines.push(`  ${item}`);
        }

        ctx.ui.notify(lines.join("\n"), "info");
      }
    });
  }

  async #pickTheme(
    ctx: ExtensionCommandContext,
    planner: SetupPlanner,
    themeRecords: ReturnType<ResourceCatalog["load"]>["themes"]
  ): Promise<string | undefined | null> {
    const themes = planner.themeChoices(themeRecords);

    if (themes.length === 0) {
      ctx.ui.notify("No themes are registered at the repo-root themes/ directory; skipping theme selection.", "warning");

      return undefined;
    }

    const pick = await ctx.ui.select("Choose a theme", [...themes, "skip"]);

    if (pick === undefined) {
      ctx.ui.notify("Setup cancelled; nothing was written.", "warning");

      return null;
    }

    if (pick === "skip") {
      return undefined;
    }

    const result = ctx.ui.setTheme(pick);

    if (result.success) {
      return pick;
    }

    ctx.ui.notify(`Theme "${pick}" could not be applied: ${result.error ?? "unknown error"}`, "warning");

    return undefined;
  }
}
