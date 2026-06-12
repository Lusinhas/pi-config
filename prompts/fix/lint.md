---
description: Fix all lint findings at the root cause until the linter is clean
---

Make the project's linter pass with zero errors and no new warnings.

Discover the real lint command from package.json scripts, Makefile, CI config, or docs (e.g. `eslint .`, `ruff check`, `cargo clippy`, `golangci-lint run`) and run it with the project's own configuration. If an autofix mode exists (`--fix`), run it first for the mechanical issues, then review the resulting diff carefully — autofixes can change behavior, for example by reordering imports with side effects or deleting "unused" code that is actually load-bearing.

Fix the remaining findings by hand at the root cause: actually remove the dead code, handle the unhandled promise, fix the hook dependency array. Do not disable rules, add inline suppressions (`eslint-disable`, `noqa`, `#[allow]`), or weaken the lint config; if a rule is genuinely inapplicable somewhere, stop and explain rather than silently suppressing.

If a formatter is configured (prettier, black, gofmt), run it last so formatting does not churn repeatedly. Re-run lint until clean, paste the clean output, and summarize the fixes grouped by rule.
