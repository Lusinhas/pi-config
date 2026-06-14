---
name: release
description: "Cuts a release end to end: semver from commit history, grouped changelog, version bumps, tag, GitHub release; supports dry-run. Use to release, tag, bump, or generate a changelog."
disable-model-invocation: true
---

A release is a pile of irreversible side effects (tags, published releases, sometimes registry uploads), so this skill computes everything first, shows it, and mutates last. Default to dry-run when the user's intent is at all ambiguous ("prep a release", "what would the next version be") and only execute the mutating tail on explicit confirmation — use the `ask` tool for that confirmation when available; otherwise present the dry-run output and end the turn asking to proceed.

## Workflow

1. **Establish the baseline.** Preconditions: clean tree, on the release branch, up to date with the remote.

   ```bash
   git status --porcelain
   git fetch --tags origin
   LAST=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
   echo "last tag: ${LAST:-none}"
   ```

   No tags yet means this is the first release: take the version from the manifest (often 0.1.0) and the full history as the changelog range.

2. **Collect commits and derive the bump.**

   ```bash
   git log "${LAST:+$LAST..}HEAD" --no-merges --pretty=format:"%h %s%n%b---"
   ```

   With conventional commits: any `BREAKING CHANGE:` footer or `!` after the type (`feat!:`) → major; any `feat:` → minor; otherwise (`fix:`, `perf:`, etc.) → patch. Pre-1.0 convention: breaking → minor, everything else → patch. Without conventional commits, read the actual diffs of significant commits (`git show --stat`) and judge: API removals/renames are breaking, new public surface is minor, the rest is patch — and say in the report that the bump was judged, not parsed. When the call is genuinely close, present both candidates via `ask`.

3. **Generate the changelog.** Group by type, breaking changes first, in this order: **Breaking Changes**, **Features**, **Bug Fixes**, **Performance**, **Other**. Each entry: imperative summary, commit short-hash, PR number if present in the subject (`(#412)`). Drop pure noise (`chore: fix typo in comment`), keep anything user-visible. Scoped commits (`feat(parser): ...`) keep the scope as a bold prefix. Write it to `/tmp/release-notes.md` and, if a `CHANGELOG.md` exists, prepend the new section under the existing header preserving its established style (compare with the previous release's section before writing). Use `webfetch` to pull linked PR descriptions when a commit subject is too terse to summarize; without it, use the commit body.

4. **Update version manifests.** Find every file that carries the version and update them all consistently: `package.json` (+ `package-lock.json` via `npm version --no-git-tag-version`), `Cargo.toml` (+ `cargo check` to refresh the lockfile), `pyproject.toml`, `version.go`, etc.

   ```bash
   grep -rn "\"version\": \"1\.4\." --include="*.json" . | grep -v node_modules
   npm version 1.5.0 --no-git-tag-version
   ```

   Monorepos: determine whether versions are locked (bump all) or independent (bump only changed packages) by checking lerna/changesets/workspace config before touching anything.

5. **Dry-run gate.** Print: computed version and why, full changelog, the files modified so far (changelog, manifests), and the exact mutating commands from step 6. If the user asked for dry-run or does not confirm, revert the working-tree edits from steps 3-4 (`git checkout -- CHANGELOG.md package.json package-lock.json` or equivalent) and **stop here** — a dry run leaves the tree clean.

6. **Verify, then execute the mutating tail, in this order** (each step only after the previous succeeds). First the verification: run the repo's build and test suite, or confirm the latest CI run on this branch is green (`gh run list --branch "$(git branch --show-current)" --limit 1`); a red result blocks the release absent explicit user override.

   ```bash
   git add -A && git commit -m "release: v1.5.0"
   git tag -a v1.5.0 -m "v1.5.0"
   git push origin HEAD --follow-tags
   gh release create v1.5.0 --title "v1.5.0" --notes-file /tmp/release-notes.md
   ```

   Match the repo's existing tag style (`v1.5.0` vs `1.5.0`) — check with `git tag --list | tail`. If `gh` is unavailable, push the tag and output the release notes with instructions to create the release manually. Pre-releases: `gh release create v1.5.0-rc.1 --prerelease`. Do **not** run `npm publish`/`cargo publish` unless explicitly asked — registry pushes are not undoable.

## Edge cases

- **Tag already exists:** never delete or force-move a pushed tag; report it and propose the next patch version.
- **Step 6 fails midway** (push rejected, gh auth): report exactly which side effects already happened (local commit? local tag? pushed?) and the precise rollback commands (`git tag -d v1.5.0`, `git reset --hard HEAD~1`) — but only run rollbacks on request.
- **CI is red on the release commit:** stop before tagging; releasing a red build needs explicit user override.
- **Commits since last tag are empty or all noise:** report "nothing to release" instead of manufacturing a patch bump.
- **CHANGELOG.md is generated by tooling** (changesets, release-please): defer to that tool's flow and say so rather than hand-writing a conflicting section.

## Done when

- [ ] Last tag, commit range, and computed bump shown with the rule that produced it
- [ ] Changelog grouped by type, breaking changes first, noise filtered
- [ ] Every version-bearing manifest updated consistently (verified by grep for the old version)
- [ ] Build/tests or latest CI confirmed green before tagging
- [ ] Dry-run output presented; mutations executed only after explicit confirmation; declined runs left a clean tree
- [ ] Tag pushed and GitHub release created with the changelog body (or manual instructions given)
- [ ] Any partial failure reported with exact already-applied effects and rollback commands
