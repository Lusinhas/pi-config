import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  describeError,
  formatStamp,
  listSessions,
  loadTranscript,
  oneLine,
  searchSessions,
} from "./tools";
import type { SearchHit, SessionsConfig } from "./tools";
import { notify, showText } from "./viewer";

function formatHits(query: string, hits: SearchHit[], cap: number): string {
  const sessionCount = new Set(hits.map((hit) => hit.path)).size;
  const lines: string[] = [
    `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}" in ${sessionCount} session${sessionCount === 1 ? "" : "s"}${hits.length >= cap ? ` (capped at ${cap})` : ""}:`,
  ];
  let lastPath = "";
  for (const hit of hits) {
    if (hit.path !== lastPath) {
      lastPath = hit.path;
      lines.push("", `${hit.sessionId.slice(0, 8)}  ${formatStamp(hit.modified)}  ${hit.sessionTitle}`, `  ${hit.path}`);
    }
    lines.push(`  [${hit.itemIndex} ${hit.label}] ${hit.excerpt}`);
  }
  return lines.join("\n");
}

function contextFor(hit: SearchHit, span: number): string {
  const transcript = loadTranscript(hit.path);
  const start = Math.max(0, hit.itemIndex - span);
  const end = Math.min(transcript.items.length, hit.itemIndex + span + 1);
  const parts: string[] = [];
  for (const item of transcript.items.slice(start, end)) {
    const marker = item.index === hit.itemIndex ? "→ " : "";
    parts.push(`${marker}[${item.index}] ${item.label}: ${item.text}`);
  }
  if (parts.length === 0) return "(the matched entry is no longer present in this session file)";
  return parts.join("\n\n");
}

function currentSessionFile(ctx: ExtensionCommandContext): string {
  try {
    const file: unknown = ctx.sessionManager.getSessionFile();
    return typeof file === "string" ? file : "";
  } catch {
    return "";
  }
}

async function offerSwitch(ctx: ExtensionCommandContext, hit: SearchHit): Promise<boolean> {
  if (hit.path === currentSessionFile(ctx)) return false;
  const go = await ctx.ui.confirm(
    "Switch session",
    `Switch to ${hit.path}? The current session will be left as-is and this one opened in its place.`,
  );
  if (!go) return false;
  try {
    await ctx.switchSession(hit.path, {});
    return true;
  } catch (error) {
    notify(ctx, `search: could not switch session: ${describeError(error)}`, "error");
    return false;
  }
}

export function registerSearchCommand(pi: ExtensionAPI, config: SessionsConfig): void {
  pi.registerCommand("search", {
    description: 'Search saved session transcripts for literal text; add "--all" to include every project',
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      let query = (args ?? "").trim();
      let all = false;
      if (/(^|\s)--all(\s|$)/.test(query)) {
        all = true;
        query = query.replace(/(^|\s)--all(\s|$)/g, " ").trim();
      }
      if (query === "" && ctx.mode === "tui" && ctx.hasUI) {
        const asked = await ctx.ui.input("Search sessions", "literal text to find");
        query = (asked ?? "").trim();
      }
      if (query === "") {
        notify(ctx, "Usage: /search <query> [--all]", "warning");
        return;
      }
      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus("sessions", `searching for "${oneLine(query, 32)}"…`);
        } catch {
          void 0;
        }
      }
      let hits: SearchHit[] = [];
      try {
        const sessions = await listSessions(ctx.cwd, all);
        hits = searchSessions(query, sessions, config.searchLimit, config.excerptChars, ctx.signal);
      } catch (error) {
        notify(ctx, `search: ${describeError(error)}`, "error");
        return;
      } finally {
        if (ctx.hasUI) {
          try {
            ctx.ui.setStatus("sessions", undefined);
          } catch {
            void 0;
          }
        }
      }
      if (hits.length === 0) {
        notify(ctx, `No matches for "${query}"${all ? "" : ' (add "--all" to search every project)'}.`, "info");
        return;
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        console.log(formatHits(query, hits, config.searchLimit));
        return;
      }
      const options = hits.map((hit, index) =>
        oneLine(`${index + 1}. ${formatStamp(hit.modified)}  ${hit.sessionTitle} · ${hit.excerpt}`, 110),
      );
      for (;;) {
        const choice = await ctx.ui.select(`${hits.length} matches for "${oneLine(query, 40)}" — open one`, options);
        if (choice === undefined) return;
        const picked = hits[Number.parseInt(choice, 10) - 1];
        if (!picked) return;
        let contextText: string;
        try {
          contextText = contextFor(picked, config.contextEntries);
        } catch (error) {
          notify(ctx, `search: ${describeError(error)}`, "error");
          return;
        }
        await showText(
          ctx,
          `${picked.sessionId.slice(0, 8)} · ${formatStamp(picked.modified)} · ${picked.sessionTitle}`,
          contextText,
        );
        if (config.allowSwitch) {
          const switched = await offerSwitch(ctx, picked);
          if (switched) return;
        }
      }
    },
  });
}
