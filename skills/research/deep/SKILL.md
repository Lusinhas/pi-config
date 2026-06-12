---
name: deep
description: "Deep multi-source web research: decompose, fan out searches, fetch primary sources, cross-check claims, synthesize a cited report. Use for research, comparisons, fact-checks, or current-state questions."
disable-model-invocation: true
---

# Deep research

Produce a research report the user can act on without re-verifying it. The output is not a list of links; it is a set of claims, each tied to sources that were actually fetched, with an honest confidence label.

## Workflow

1. **Scope.** Restate the question in one sentence. If it is underspecified (no timeframe, region, budget, or success criterion), use the `ask` tool to get 2-3 constraints before searching; if `ask` is unavailable, pick reasonable assumptions and state them at the top of the report.
2. **Decompose.** Split into 3-7 sub-questions covering: definitions/background, current state, competing options or claims, hard numbers and dates, and known criticisms. Track them with the `todo` tool, or as a markdown checklist kept in your working notes if `todo` is disabled.
3. **Fan out searches.** For each sub-question run 2-3 `websearch` queries with deliberately different framing:
   - neutral: `sqlite wal2 mode status`
   - adversarial: `sqlite wal2 problems criticism`
   - recency-pinned: `sqlite wal2 2026 merged`
   When the `task` tool is available, spawn one task agent per sub-question in parallel; instruct each to return claims with URL, publish date, and a supporting quote — not prose summaries.
4. **Fetch primary sources.** `webfetch` the top 2-4 results per sub-question. Prefer primary material (papers, official docs, release notes, filings, issue trackers) over blogs and aggregators. For every claim you keep, record: the claim, URL, publish date, and the exact sentence supporting it.
5. **Adversarial cross-check.** A claim is load-bearing if removing it changes the conclusion. Every load-bearing claim needs two independent sources — different publishers, not citing each other. For each surprising claim, run one search that explicitly tries to falsify it. Label each claim `confirmed`, `single-source`, or `disputed`.
6. **Synthesize.** Write the report: TL;DR (3-5 sentences), findings grouped by sub-question with inline `[1]`-style citations, a confidence level per finding (high/medium/low plus one line of reasoning), a "Disagreements" section where sources conflict, "Open questions" for anything unresolved, and a numbered source list with dates. Return the report inline; `write` it to a file only when the user asked for one. For high-stakes conclusions, run the draft past the `advisor` tool if available.

## Fallback without web extensions

If `websearch`/`webfetch` are disabled, use bash with curl:

```
  curl -s "https://html.duckduckgo.com/html/?q=sqlite+wal2+status" \
    | grep -oE 'uddg=[^&"]+' | sed 's/^uddg=//' \
    | python3 -c 'import sys,urllib.parse; [print(urllib.parse.unquote(l.strip())) for l in sys.stdin]' | head -20
  curl -sL "https://sqlite.org/cgi/src/doc/wal2/doc/wal2.md" | sed -e 's/<[^>]*>//g' | head -200
```

If outbound network is blocked entirely, stop and tell the user research cannot proceed — do not answer from memory while presenting it as researched.

## Edge cases and failure handling

- **Paywalled or 403 pages:** retry via `https://web.archive.org/web/2026/` plus the original URL; or search the article title plus `pdf`. If still blocked, drop the source rather than cite it unread.
- **SEO farms and AI-generated filler:** discard pages with no named author, no dates, and no outbound citations.
- **Staleness:** record publish dates. For fast-moving topics (pricing, releases, leadership), treat anything older than 12 months as historical context only.
- **Conflicting numbers:** report the range and cite both sides; never average silently.
- **Fetch failures or rate limits:** retry once, then substitute the next search hit; note the substitution.
- **Echo chambers:** if all sources trace to one press release, the claim is `single-source` no matter how many URLs repeat it.
- **Never fabricate:** every URL in the report must have been returned by a search or fetched this session. If evidence is missing, say so in "Open questions".

## Done criteria

- [ ] Every sub-question is answered or explicitly listed as open
- [ ] Every load-bearing claim has two independent sources, or is labelled `single-source`/`disputed`
- [ ] Every URL cited in support of a claim was fetched this session; search-returned-but-unfetched URLs appear only as leads, never as claim support
- [ ] Each finding carries a confidence level with a one-line justification
- [ ] Publish dates recorded for all sources; stale sources flagged
- [ ] Report contains TL;DR, Disagreements, Open questions, and a dated source list
