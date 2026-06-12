---
description: Produce a handoff brief of this session — goal, state, decisions, next steps
---

Produce a handoff brief of this session so a fresh session, or another person, can continue without rereading the transcript.

Reconstruct from evidence, not memory alone: check `git status`, `git diff --stat`, and recent commits to confirm what actually changed versus what was merely discussed. Then write the brief with exactly these sections:

- **Goal** — what the session set out to do, in one or two sentences.
- **State** — done, in progress, and untouched work; name the modified files and whether changes are committed, staged, or loose in the tree.
- **Decisions** — choices made and the reasoning: approach picked, alternatives rejected, constraints discovered. These are the costliest thing to lose.
- **Gotchas** — anything surprising learned the hard way: flaky tests, misleading docs, environment quirks.
- **Next steps** — ordered, concrete actions; make the first one specific enough to start on immediately.

Write the brief to `.pi/handoff.md`, overwriting any previous one, and also print it in your reply. Be specific throughout: file paths, command names, exact error messages — never vague summaries.
