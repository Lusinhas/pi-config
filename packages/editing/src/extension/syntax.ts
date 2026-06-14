import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Lang, parseAsync } from "@ast-grep/napi";
import { Core } from "../syntax/index.ts";
import { Config } from "../syntax/settings.ts";
import type { AstConfig } from "../syntax/settings.ts";
import type { ParsedSource, ScanResult } from "../syntax/scan.ts";
import { ScanSession } from "../syntax/scan.ts";
import type { TargetFile } from "../syntax/discovery.ts";
import type { Planned, StagedFile, WriteOutcome } from "../syntax/rewrite.ts";
import type { SearchRequest, ToolOutput } from "../syntax/index.ts";
import type { RewriteRequest } from "../syntax/rewrite.ts";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

class Napi {
  private supportedCache: Set<string> | null = null;

  read(file: TargetFile): string {
    return readFileSync(file.abs, "utf8");
  }

  async parse(lang: string, content: string): Promise<ParsedSource> {
    return (await parseAsync(lang, content)) as unknown as ParsedSource;
  }

  supportedLangs(): Set<string> {
    if (this.supportedCache !== null) {
      return this.supportedCache;
    }

    const values = new Set<string>();

    try {
      const source = Lang as unknown as Record<string, unknown>;
      const names = [...Object.getOwnPropertyNames(source), ...Object.keys(source)];

      for (const name of names) {
        const value = source[name];

        if (typeof value === "string") {
          values.add(value);
        }
      }
    } catch {
      values.clear();
    }

    this.supportedCache = values;

    return values;
  }

  scan(supported: Set<string>): (files: TargetFile[], pattern: string, maxMatches: number, signal: AbortSignal | undefined) => Promise<ScanResult> {
    const self = this;

    return (files, pattern, maxMatches, signal) =>
      new ScanSession(files, pattern, maxMatches, supported, self, signal).run();
  }

  async write(files: Array<StagedFile | Planned>): Promise<WriteOutcome> {
    const written: string[] = [];
    const raced: string[] = [];
    const failed: string[] = [];

    for (const file of files) {
      await withFileMutationQueue(file.abs, async () => {
        let current: string;

        try {
          current = readFileSync(file.abs, "utf8");
        } catch {
          raced.push(file.rel);

          return;
        }

        if (sha(current) !== file.hash) {
          raced.push(file.rel);

          return;
        }

        try {
          writeFileSync(file.abs, file.after, "utf8");
          written.push(file.rel);
        } catch (error) {
          failed.push(`${file.rel}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }

    return { written, raced, failed };
  }

  gitFiles(pi: ExtensionAPI): (dir: string, timeout: number) => Promise<string[] | undefined> {
    return async (dir, timeout) => {
      try {
        const probe = await pi.exec("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { timeout });

        if (probe.code !== 0 || probe.stdout.trim() !== "true") {
          return undefined;
        }

        const listed = await pi.exec("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
          timeout,
        });

        if (listed.code !== 0) {
          return undefined;
        }

        return listed.stdout
          .split("\0")
          .filter((entry) => entry.length > 0)
          .map((entry) => join(dir, entry));
      } catch {
        return undefined;
      }
    };
  }
}

function searchParameters(choices: string[]) {
  return Type.Object({
    pattern: Type.String({ description: "ast-grep pattern, e.g. console.log($MSG) or $FN($$$ARGS)" }),
    lang: Type.Optional(StringEnum(choices, { description: "Force a language instead of inferring from file extensions" })),
    paths: Type.Optional(
      Type.Array(Type.String(), { description: "Files or directories to search (default: working directory)" }),
    ),
    context: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, description: "Context lines around each match" })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum matches to return (default 50)" }),
    ),
  });
}

function rewriteParameters(choices: string[]) {
  return Type.Object({
    pattern: Type.Optional(Type.String({ description: "ast-grep pattern to match, e.g. console.log($MSG)" })),
    rewrite: Type.Optional(
      Type.String({
        description: "Replacement code; metavariables from pattern are substituted. Empty string deletes matches",
      }),
    ),
    lang: Type.Optional(StringEnum(choices, { description: "Force a language instead of inferring from file extensions" })),
    paths: Type.Optional(
      Type.Array(Type.String(), { description: "Files or directories to rewrite (default: working directory)" }),
    ),
    apply: Type.Optional(Type.Boolean({ description: "Write changes immediately instead of staging a preview" })),
    applyId: Type.Optional(
      Type.String({ description: "Commit a previously staged rewrite by id; ignores other parameters" }),
    ),
  });
}

export class AstgrepRegistrar {
  private readonly pi: ExtensionAPI;
  private readonly config: AstConfig;
  private readonly core: Core;
  private readonly choices: string[];

  constructor(pi: ExtensionAPI, config: AstConfig) {
    this.pi = pi;
    this.config = config;
    this.choices = Config.langChoices(config.langMap);

    const napi = new Napi();
    const available = [...napi.supportedLangs()].sort();

    this.core = new Core({
      config,
      choices: this.choices,
      available,
      gitFiles: napi.gitFiles(pi),
      scanner: napi.scan(napi.supportedLangs()),
      writer: (files) => napi.write(files),
      reader: (abs) => readFileSync(abs, "utf8"),
    });
  }

  register(): void {
    this.registerSearch();
    this.registerRewrite();
  }

  private registerSearch(): void {
    const core = this.core;

    this.pi.registerTool({
      name: "astsearch",
      label: "AST Search",
      description:
        'Structural code search using ast-grep AST patterns (not regex). A pattern is real code with metavariables: $NAME matches one AST node, $$$NAME any number (e.g. "$FN($$$ARGS)" finds every call). The pattern must parse as a complete snippet in the target language; lang overrides per-file inference. Searches the working directory, honoring .gitignore in git repos.',
      parameters: searchParameters(this.choices),
      async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolOutput> {
        return core.runSearch(params as SearchRequest, ctx.cwd, signal);
      },
    });
  }

  private registerRewrite(): void {
    const core = this.core;

    this.pi.registerTool({
      name: "astrewrite",
      label: "AST Rewrite",
      description:
        'Structural search-and-replace using ast-grep AST patterns. pattern and rewrite are real code with metavariables: $NAME captures one AST node, $$$NAME a node list, and captures substitute into rewrite (e.g. pattern "console.log($MSG)", rewrite "logger.info($MSG)"). By default changes are only staged: a diff preview plus applyId returns; call again with just {"applyId": "<id>"} to write, or pass apply: true to write immediately. Staged files are hash-checked before apply. lang overrides per-file inference; protectGlobs files are never rewritten.',
      parameters: rewriteParameters(this.choices),
      async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolOutput> {
        return core.runRewrite(params as RewriteRequest, ctx.cwd, signal);
      },
    });
  }
}
