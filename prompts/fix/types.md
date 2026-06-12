---
description: Fix all type errors at the root cause until the type checker is clean
---

Make the project's type checker pass with zero errors.

Find the real type-check command first: check package.json scripts, Makefile, CI config, or project docs (e.g. `tsc --noEmit`, `mypy`, `pyright`, `cargo check`); use the project's own command and configuration, never an ad-hoc invocation with different strictness. Run it and capture the full error list.

Fix errors at the root cause: correct the wrong type, narrow properly, fix the actual logic mismatch. Never silence errors — no `any`, no `as` casts to dodge a mismatch, no `@ts-ignore`/`@ts-expect-error` or `# type: ignore`, no loosening compiler or mypy strictness, no deleting annotations — unless the user explicitly approves a specific suppression, and then only with a comment explaining why. When one fix can cascade (a wrong type at a module boundary producing dozens of downstream errors), fix the boundary first and re-run before touching the rest.

Re-run the checker after each batch of fixes and repeat until clean. Finish with one final clean run pasted as proof, plus a summary of the error categories found and how each was fixed.
