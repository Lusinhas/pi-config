---
name: ci
description: "Drives failing CI back to green: fetch failing runs with gh, reproduce locally, fix one failure class at a time, distinguish flakes from real breaks. Use when CI is red."
disable-model-invocation: true
---

The fastest route to green CI is reproducing failures locally and fixing them in classes, not push-and-pray iterations. Each CI round trip costs minutes; each local repro costs seconds. The hard rule: a fix may change code or fix a broken test, but never quietly change what a test asserts — that decision belongs to the user.

## Workflow

1. **Fetch the failure surface.**

   ```bash
   gh run list --branch "$(git branch --show-current)" --limit 5
   gh run view 9482716530 --log-failed
   gh run view 9482716530 --json jobs --jq '.jobs[] | select(.conclusion=="failure") | .name'
   ```

   If `gh` is unavailable, ask the user to paste the failing log. Read the workflow file itself (`.github/workflows/ci.yml`) to learn the *exact* commands, versions, and env CI uses — this is the contract you must reproduce.

2. **Classify failures before fixing anything.** Group every failing job/step into classes: lint, typecheck, unit tests, integration tests, build, infra (checkout, cache, runner death). Track classes with the `todo` tool; without it, list them in your working notes. Order: infra noise first (it masks everything), then lint/typecheck (cheap, often cascade), then tests, then build/packaging.

3. **Reproduce locally with CI's commands, not your habits.** If CI runs `npm run lint -- --max-warnings 0`, run exactly that, not `npm run lint`:

   ```bash
   CI=true npm ci
   CI=true npm run test:unit -- --coverage
   ```

   Match versions when the failure smells environmental: `node --version` vs the workflow's `node-version:`. For "works locally" cases, reproduce in a clean clone — `git clone . /tmp/ci-repro && cd /tmp/ci-repro && npm ci` — to catch untracked-file and stale-cache dependencies.

4. **Fix one class, verify locally, then move on.** Keep commits scoped per class (`fix: satisfy strict null checks in importer`) so a regression in round 2 is attributable. Re-run the class's exact command until clean before touching the next class.

5. **Push and watch.**

   ```bash
   git push
   run=$(gh run list --commit "$(git rev-parse HEAD)" --json databaseId --jq '.[0].databaseId')   # empty right after push — retry until set
   gh run watch "$run" --exit-status
   ```

   `--exit-status` makes the command fail if the run fails, so you can chain on it. If new failures appear that were previously masked (lint passed, now tests run), that is normal — re-enter at step 2.

6. **Flake protocol.** Suspect a flake when: the failure is in a test untouched by the diff, involves timing/network/ports, or differs between two runs of the same commit.
   - Confirm: `gh run rerun 9482716530 --failed`. Also check history: `gh run list --workflow ci.yml --limit 20` — if the same test fails intermittently on main, it is a flake.
   - One retry maximum. If the rerun passes, do not stop there: fix the flake (replace sleeps with condition polling, isolate the port with `port: 0`, mock the clock, pin the random seed) or, with the user's knowledge, quarantine it with a tracked skip annotation referencing an issue. Retrying in a loop until green is forbidden — it ships a landmine.

7. **The stop condition.** If the only path to green is weakening an assertion, deleting a test, broadening an expected-error match, or bumping a snapshot you cannot explain, stop. Report: which test, what it currently asserts, why the new code violates it, and the two options (change the code to satisfy the test, or change the test's intent). Use the `ask` tool to put the decision to the user; without it, end your turn with the question. Never commit `it.skip` silently.

## Edge cases

- **Failure only in CI, never locally:** diff the environments — OS (ubuntu vs your machine), case-sensitive filesystem, timezone (`TZ=UTC npm test`), locale, missing service containers. The workflow's `services:` block tells you what to start locally via docker.
- **Cache poisoning:** if errors reference files that no longer exist, bump the cache key in the workflow or use the re-run UI's cache-less option.
- **Required secrets missing on fork PRs:** jobs that need secrets legitimately cannot pass from a fork; report this rather than fighting it.
- **Matrix failures on one variant only:** reproduce with that variant's version via your version manager before assuming the test is wrong.
- **Red main branch:** if main is already red, rebase fixes nothing — report that the failure pre-exists the branch, with the first bad run as evidence.

## Done when

- [ ] All failing jobs fetched, read, and grouped into classes
- [ ] Each failure reproduced locally with CI's exact command (or documented why not)
- [ ] Fixes committed per class; no assertion weakened or test skipped without explicit user sign-off
- [ ] Flakes retried at most once and then actually fixed or visibly quarantined
- [ ] Final run green, confirmed via gh run watch --exit-status on the latest commit
- [ ] Summary lists each failure class, its root cause, and its fix
