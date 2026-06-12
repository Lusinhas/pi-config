---
description: Explain how something works in this codebase with file:line evidence
argument-hint: <topic, feature, or symbol>
---

Explain how $@ works in this codebase, grounded entirely in the actual source.

Locate the implementation first: search for the relevant symbols, routes, or config keys, and read every file on the main code path — entry point, core logic, and the call sites that drive it. Trace the real control flow rather than inferring from names; if behavior depends on configuration or runtime state, identify which file sets it.

Structure the answer as: (1) a two-sentence summary of what it does; (2) a step-by-step walkthrough of the flow in execution order, citing file:line for every claim (e.g. src/auth/session.ts:42); (3) the key data structures or invariants involved; (4) edge cases, error handling, and any surprising behavior you found along the way. Quote short snippets only where the exact code is decisive.

If parts are ambiguous or no implementation can be found, say so explicitly instead of guessing. Keep the explanation about mechanics specific to this repo, not generic theory the reader could get elsewhere. Do not modify any files.
