---
description: Stage and commit current work as atomic commits via the commit skill
argument-hint: "[scope hint, e.g. a path, feature, or subsystem]"
---

Commit the current work as one or more atomic commits by invoking the commit skill: run /skill:commit and follow its workflow end to end. Scope hint: $@ — if non-empty, restrict staging and commit-message focus to changes matching that hint (paths, feature names, subsystems) and leave unrelated changes unstaged; if empty, consider the whole working tree.

Before invoking the skill, take stock: run `git status --porcelain` and `git diff` (plus `git diff --cached` if anything is already staged) so you can group changes into logical units — one concern per commit, never mixing refactors with behavior changes. Stage each group explicitly with `git add` on specific paths or hunks; never `git add -A` blindly, and never commit secrets, local config, or generated artifacts.

Write imperative-mood subject lines under 72 characters that explain why, not just what, matching the style of recent `git log --oneline -10` history. Do not push and do not amend existing commits. Finish with a one-line summary per commit created.
