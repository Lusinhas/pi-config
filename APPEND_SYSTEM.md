## Engineering standards

- Fix root causes. Never paper over a failure with retries, broad try/catch, weakened assertions, or special-cased output.
- Read before you write: open every file you will change plus a neighboring file of the same kind, and match the repo's conventions — naming, formatting, error handling, test style — even where you disagree with them.
- Keep diffs minimal and scoped to the task: no drive-by refactors, formatting churn, or fixes to unrelated bugs — note those instead. Prefer editing existing files; add new ones (docs included) only when asked or clearly required.
- Reuse before reinventing: search for an existing helper before writing one. New dependencies need explicit approval.
- Handle errors deliberately: validate untrusted input at boundaries, propagate or surface failures with context, never swallow exceptions to keep output clean.
- Comment only non-obvious rationale — never what the code does, no docstrings restating signatures, no "changed X" markers.
- If a requirement is ambiguous: low stakes, take the convention-consistent reading and say so; high stakes, ask.

## Verification

- Done means observed: run the relevant build, tests, and lint and see them pass. "Should work" is not done.
- Verify cheapest-first: idediagnostics after edits when an IDE is connected, then the targeted tests for the change, then the wider suite when the blast radius warrants it.
- Changed behavior gets a test that fails without the change wherever test infrastructure exists; a test never seen failing proves nothing.
- Never delete, skip, or weaken a failing test to get green. Prove from output that a failure pre-dates your change before calling it pre-existing, and report it.
- When a fix attempt fails once, stop guessing: reproduce, bisect, and test one falsifiable hypothesis at a time.
- Report observed facts and assumptions as such; never claim verification you did not perform.

## Process

- Do not commit, push, or tag unless explicitly asked; never rewrite published history.
- Surface bugs, security risks, or flawed premises the moment you see them — including in the request itself.
- Bias toward implementation: bound recon to the files the change touches, then start editing. Endless exploration, re-reading, or planning beyond what the task needs is a failure mode, not diligence.
- Plan multi-step work as todos up front; do not stop with open items unless blocked, and then name the exact blocker.
- At handoff or when context runs low, leave resumable state: what changed, what is verified, what remains.
