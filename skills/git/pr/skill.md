---
name: pr
description: "Drives branch-to-PR with the gh CLI: full branch diff summary, conventional title and body, push, open, and address review comments. Use to open, update, or respond to a pull request."
disable-model-invocation: true
---

# Pull requests with gh

Create and tend pull requests that describe the whole branch, not the last commit, and that read like the repo's other PRs. Everything goes through `gh`; when `gh` is missing or unauthenticated, fall back to plain `git push` plus a hand-written PR text the user can paste.

## Creating a PR

1. Establish state. All read-only, run them up front:

  ```sh
  git status --porcelain
  git branch --show-current
  gh auth status
  gh repo view --json defaultBranchRef,nameWithOwner -q '.defaultBranchRef.name + " " + .nameWithOwner'
  ```

  If on the default branch, stop — create a feature branch first. If the tree is dirty, ask whether those changes belong in this PR (commit them via the commit skill) or should stay local.

2. Summarize the full branch diff against the merge base. The PR describes everything since divergence:

  ```sh
  base=main   # from defaultBranchRef above, unless the user names another base
  git log --oneline $base..HEAD
  git diff $base...HEAD --stat
  git diff $base...HEAD
  ```

  Use three-dot for diffs (changes since the merge base) so an outdated local `main` does not pollute the summary. If the diff is large, read the stat plus per-directory diffs rather than skipping files.

3. Learn the repo's PR conventions before writing a word:

  ```sh
  gh pr list --state merged --limit 10 --json title,body -q '.[] | .title'
  cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null || cat .github/pull_request_template.md 2>/dev/null
  ```

  Match title style (conventional prefix? ticket id like `ABC-123`? sentence case?). If a template exists, fill every section; delete none. If the `webfetch` tool is available and CONTRIBUTING.md links external guidelines, fetch them; otherwise rely on the merged-PR sample.

4. Push with tracking, then create:

  ```sh
  git push -u origin HEAD
  gh pr create --base "$base" --title 'fix(parser): handle empty heredoc bodies' --body-file /tmp/pr-body.md
  ```

  Write the body to a temp file first (heredocs with backticks get mangled in shells). Body covers: what changed and why (problem before solution), notable decisions/tradeoffs, how it was tested, and anything reviewers should look at first. Never include a commit-by-commit list as the whole body. Add `--draft` when the user asked for a draft, when CI is expected to need iteration, or when the work is explicitly WIP. Print the PR URL `gh pr create` returns.

5. Watch CI if asked or if the change is risky: `gh pr checks --watch`. On failure, find the run id (`gh run list --branch "$(git branch --show-current)" --limit 5`, or the link from `gh pr checks`), then `gh run view <run-id> --log-failed`; fix, push, re-check.

## Handling review comments

1. Fetch everything — three distinct comment streams exist:

  ```sh
  gh pr view 123 --json reviews,comments,reviewDecision
  gh api repos/{owner}/{repo}/pulls/123/comments --paginate   # inline code comments
  ```

  The `gh api` call is the only one that returns inline review comments with `path`, `line`, and `in_reply_to_id`. If the `todo` tool is available, file one todo per actionable comment so none is dropped; otherwise enumerate them in your reply and check each off.

2. For each comment: read the referenced code at the referenced line, decide fix vs push-back, make the change (separate commit per concern — do not force-push squashes mid-review unless the repo's convention is squash-on-update), and reply:

  ```sh
  gh api repos/{owner}/{repo}/pulls/123/comments/456789/replies -f body='Done in a1b2c3d.'
  ```

  Push once at the end, then a summary comment: `gh pr comment 123 --body '...'`. If a comment's request is ambiguous or you disagree, use the `ask` tool to consult the user before replying; without it, draft the push-back reply and show the user before posting.

## Edge cases and failure handling

- Fork workflow: `gh repo view` shows upstream as `nameWithOwner`; push to your fork remote and create with `gh pr create --repo upstream/name --head youruser:branch`.
- Push rejected (non-fast-forward): someone updated the branch — `git pull --rebase` (tracking was set by `-u`) then push; never force-push over a colleague's commits.
- PR already exists for the branch: `gh pr create` fails; switch to `gh pr edit --title --body-file` and say so.
- No commits ahead of base: nothing to PR — report instead of opening an empty PR.
- `gh` unauthenticated and login impossible non-interactively: push the branch, output the compare URL (`https://github.com/OWNER/REPO/compare/main...branch`) plus the ready title/body for manual creation.

## Done criteria

- [ ] PR body reflects the full `base...HEAD` diff, in the repo's template/format
- [ ] Title matches the style of recently merged PRs
- [ ] Branch pushed with `-u` tracking; PR URL reported to the user
- [ ] Draft/ready state matches what the user asked for
- [ ] Every inline review comment fetched via `gh api`, addressed or answered, with replies posted
