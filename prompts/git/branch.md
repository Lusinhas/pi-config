---
description: Create a well-named branch from a description and switch to it
argument-hint: <short description of the work>
---

Create a new git branch for the work described as: $1

Derive a branch name first: lowercase kebab-case, two to five words capturing the change, prefixed by type — feat/, fix/, chore/, docs/, or refactor/ — chosen from the description's intent (e.g. "fix login redirect loop" becomes fix/login-redirect-loop). Check existing conventions with `git branch --list` and `git log --oneline --branches -10` and match any prefix or ticket-id pattern the repo already uses (e.g. user/name/topic or JIRA-123-slug) instead of imposing your own. Verify the name is unused with `git rev-parse --verify --quiet <name>`; if taken, append a short discriminator.

Before switching, run `git status`: uncommitted changes travel with the switch — confirm that is intended, otherwise stash and say so. Branch from the current HEAD unless it sits on a stale or unrelated branch, in which case `git fetch` and branch from the default branch. Create and switch in one step with `git switch -c <name>`, then report the final branch name and its start point.
