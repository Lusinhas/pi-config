---
name: codebase
description: "Layered codebase recon — structure, symbols, data flow — reported as file:line findings with an architecture summary. Use for how/where questions or before planning changes in an unfamiliar repo."
disable-model-invocation: true
---

# Codebase recon

Build an accurate, citable map of how the code actually works before touching it or explaining it. Every claim in the final answer must be backed by a `file:line` you actually read — never by inference from a filename.

## Workflow

1. **Frame and time-box.** Write down the one question recon must answer (e.g. "where does an incoming webhook become a DB row"). Set a budget: roughly 15 minutes or 30 tool calls. Track layers with the `todo` tool, or a plain checklist in notes if disabled. If the `history` tool exists, check whether this repo was already mapped in a prior session and reuse that map.
2. **Layer 0 — structure.** Identify language, framework, and module boundaries:

```
  ls
  find . -maxdepth 2 -type d -not -path '*/node_modules/*' -not -path '*/.git/*' \
    -not -path '*/dist/*' -not -path '*/target/*'
  cat package.json pyproject.toml go.mod Cargo.toml 2>/dev/null
```

   Read the README and the build/run scripts. Locate entry points: `main.*`, `index.*`, `cmd/`, route tables, CLI arg parsers, scheduler/queue consumers.
3. **Layer 1 — symbols.** Search for the nouns of the target behavior. Prefer `rg` when installed (faster, respects `.gitignore`); fall back to grep:

```
  rg -n 'webhook' -g '!*test*' --type ts | head -30
  grep -rnw 'handleWebhook' --include='*.ts' src/ | head -30
  grep -rc 'Session' src/*.ts | sort -t: -k2 -rn | head
```

   When result counts explode, count first (`grep -rc`), then narrow with `--include`, word boundaries (`-w`), or anchors (`grep -rn '^func '`). Use `astsearch` when available to separate real call sites from strings and comments — e.g. match the call expression `processEvent($$$ARGS)` instead of grepping the bare name.
4. **Layer 2 — data flow.** Pick the entry point closest to the question and walk the call chain toward the target, recording each hop as `file:line`. Read only the relevant region of each file (offset/limit), not whole files. When two subsystems are independent (e.g. HTTP layer and persistence layer), and the `task` tool is available, spawn parallel task agents with one subsystem each and instructions to return `file:line` hops only.
5. **Map.** Condense into: a 3-6 bullet architecture summary, the traced chain, key files with one-line roles, and observed invariants or gotchas (locking, implicit ordering, feature flags).
6. **Report.** Answer the framed question with `file:line` citations throughout, then the architecture summary, then an explicit "Not explored" list: directories skipped, tests not read, generated code excluded, traces abandoned at the time box. If the map is durable and reusable, save the gist as a `memory` topic for future sessions. If the architecture is ambiguous after recon, get a second read from the `advisor` tool before committing to an interpretation.

## Edge cases and failure handling

- **Generated/vendored code:** exclude `dist/`, `build/`, `vendor/`, `*.min.js`, lockfiles from all searches, and say that you did.
- **Monorepos:** find the right package first — read root `package.json` `workspaces`, `pnpm-workspace.yaml`, or `Cargo.toml` `[workspace]` — then scope every later search to that package directory.
- **Grep trace goes cold (DI, dynamic dispatch, reflection):** search for the registration site instead of the call site — decorators, `register(`, config/YAML files, dependency-injection containers, route manifests. In Ruby/Python, check metaprogramming (`define_method`, `getattr`).
- **Symbol not in the repo:** before concluding, check it is not from a dependency (`grep -rn 'createClient' node_modules/somepkg/dist | head` or the vendored source). If external, report it as such and stop tracing there.
- **Multiple plausible implementations:** trace from the entry point downward rather than from the symbol upward; the route table or CLI dispatcher disambiguates which one actually runs.
- **Time box exhausted:** stop. Report the partial map, the exact point where the trace stopped, and the next two searches you would run. A partial honest map beats a confident guess.
- **No build manifest at all (scripts dump, infra repo):** fall back to `find . -type f | sed 's/.*\.//' | sort | uniq -c | sort -rn | head` to learn the file-type mix, then layer 1 as usual.

## Done criteria

- [ ] The framed question is answered, with a `file:line` for every behavioral claim
- [ ] Entry point to target behavior traced hop by hop, each hop cited
- [ ] Every cited line was actually read this session, not inferred from names
- [ ] Architecture summary is 6 bullets or fewer
- [ ] Search exclusions and "Not explored" areas are stated
- [ ] Time box respected, or its overrun explicitly justified
