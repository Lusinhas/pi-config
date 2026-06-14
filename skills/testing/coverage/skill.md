---
name: coverage
description: "Runs the repo's native coverage tool, ranks uncovered code by risk, writes targeted tests, and reports the delta. Use to measure or meaningfully raise coverage; refuses trivial 100% chasing."
disable-model-invocation: true
---

Coverage is a gap-finding instrument, not a score to maximize. The output of this skill is a small set of high-value tests plus an honest delta report — not a number inflated by asserting that constructors construct.

## Workflow

1. Run coverage with the framework's native tool, producing both a human summary and a machine-readable report:

  ```bash
  pytest --cov=src --cov-report=term-missing --cov-report=json:coverage.json --cov-branch
  npx vitest run --coverage --coverage.reporter=text --coverage.reporter=json
  npx jest --coverage --coverageReporters=text --coverageReporters=json-summary
  go test ./... -coverprofile=cover.out && go tool cover -func=cover.out
  cargo llvm-cov --json --output-path coverage.json
  ```

  Always enable branch coverage where the tool supports it (`--cov-branch`; default in v8/istanbul; `cargo llvm-cov --branch` needs nightly; Go's profile is statement-only); line coverage alone hides untested `else` arms. If the runner is unclear, detect it the same way `/skill:unit` does — manifests and CI config, never assumption.

2. Parse the report into a gap list. Useful one-liners:

  ```bash
  jq -r '.files | to_entries[] | [.key, .value.summary.percent_covered] | @tsv' coverage.json | sort -t$'\t' -k2 -n | head -20
  go tool cover -func=cover.out | awk '$3+0 < 60 {print}' | sort -k3 -n
  ```

  For each low-coverage file, get the exact uncovered line ranges (`term-missing` output, `missing_lines` in the JSON, `go tool cover -html=cover.out` regions) and `read` those regions to see what they actually are.

3. Rank gaps by risk, not by percentage. Priority order:
  - Exported/public functions with zero coverage — these are the contract.
  - Branching logic: uncovered `if`/`match` arms, especially boundary comparisons and security/permission checks.
  - Error handling: `except`/`catch` blocks, `if err != nil` paths, rollback/cleanup code — the code that only runs when things are already going wrong is the code least affordable to be broken.
  - Hot paths identified from callers (use `astsearch` to count call sites of an uncovered function; fallback `grep -rn 'funcName(' src/ | wc -l`).

  Deprioritize or exclude: generated code, vendored code, `__repr__`/`toString`, trivial accessors, CLI argument plumbing already covered by integration tests, debug-only branches. Add exclusions explicitly (`# pragma: no cover` with a reason, `/* v8 ignore next */`, coverage config `omit` lists) rather than writing junk tests. Track the ranked gap list with the `todo` tool if available; for a large codebase, the `task` tool can parallelize gap-filling per package.

4. Write targeted tests for the top gaps following `/skill:unit` conventions: mirror existing test files, table-driven where idiomatic, real assertions on behavior. Each test must assert an observable outcome — return value, raised error, emitted call — never merely execute lines. A test whose only assertion is "did not throw" needs a justifying comment or should not exist.

5. Re-run the identical coverage command and report the delta:

  ```bash
  go tool cover -func=cover.out | tail -1
  jq '.totals.percent_covered' coverage.json
  ```

  Report per-file before/after for files you touched, total before/after, and the list of gaps you deliberately left open with reasons. Leave the raw report paths (`coverage.json`/`cover.out`) in the summary and gitignore them.

## Edge cases

- Coverage tooling not installed: add it as a dev dependency only with a matching major version of the test framework (`pytest-cov` for pytest, `@vitest/coverage-v8` for vitest); ask before adding to a lockfile-strict repo.
- Merged/parallel runs: combine first (`coverage combine`, `go test -coverprofile` per package then `gocovmerge`, `nyc merge`) or numbers will be silently wrong.
- A coverage gate (`--cov-fail-under`, `coverageThreshold`) already failing before your work: report the baseline first so the delta is attributable.
- Uncovered code that is genuinely unreachable: propose deleting it instead of testing it — dead code is the cheaper fix.
- Uncovered code that crashes the moment you test it: that is a found bug; report it and write the test asserting the correct behavior, marked as expected-failure (`xfail`, `t.Skip` with issue link) only if the fix is out of scope.
- Branch coverage stuck below line coverage: look for boolean expressions with short-circuit operators; split the cases in a parametrized table.

## Done criteria

- Coverage ran with branch coverage enabled and a machine-readable report was parsed, not eyeballed.
- Gaps were ranked by risk (public API, branches, error paths) and the ranking is visible in the summary.
- Every new test asserts behavior; none exist only to turn lines green.
- Exclusions are explicit, configured, and justified — not silent.
- The same coverage command was re-run and a per-file plus total before/after delta is reported.
- Remaining known gaps are listed with reasons, and any unreachable or broken code found is reported separately.
