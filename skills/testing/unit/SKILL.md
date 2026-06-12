---
name: unit
description: "Writes unit tests matching the repo's framework and conventions, covering happy path, boundaries, and errors, iterating until green. Use to test functions or backfill thin suites."
disable-model-invocation: true
---

Write unit tests that document real behavior and fail loudly on regressions. The test suite is the spec: every assertion you write must encode something the code is supposed to do, not something it happens to do.

## Workflow

1. Detect the framework before writing anything. Check manifests, not vibes:

  ```bash
  cat package.json | grep -E '"(jest|vitest|mocha|ava)"'
  ls pytest.ini setup.cfg pyproject.toml conftest.py 2>/dev/null
  ls go.mod Cargo.toml build.gradle pom.xml 2>/dev/null
  grep -rE 'pytest|unittest' pyproject.toml setup.cfg 2>/dev/null
  ```

  The runner command is the one CI uses — check `.github/workflows/`, `Makefile`, or the `scripts.test` entry, and prefer it verbatim (e.g. `npm test -- --runTestsByPath`, `go test ./...`, `pytest -x`, `cargo test`).

2. Find the conventions. Locate two or three existing test files nearest to the code under test and copy their dialect exactly: file naming (`foo_test.go`, `test_foo.py`, `foo.spec.ts`), directory layout (colocated vs `tests/`), import style, fixture/mocking library (`pytest` fixtures vs `unittest.mock`, `jest.mock` vs manual stubs), and assertion flavor. If the `astsearch` tool is available, use it to find the target function's definition and all its call sites to learn real usage; otherwise `grep -rn "def target_fn\|function targetFn\|fn target_fn" --include` plus `read` on the results.

3. Plan cases per function, and track them with the `todo` tool if available (one item per function under test). For each public function enumerate:
  - happy path with typical inputs,
  - boundaries: empty collection, zero, negative, max int, unicode, exactly-at-limit lengths, None/null/undefined where the signature permits,
  - error paths: invalid input raises/returns the documented error, dependencies failing (mock throws, returns malformed data),
  - any branch visible in the code (`if`, `match`, early returns) gets at least one case.

4. Use table-driven style where the language community does: Go subtests with `t.Run`, `pytest.mark.parametrize`, `it.each` in jest/vitest, `#[rstest]` or macro loops in Rust. One table per behavior, not one giant table per function — keep failure messages diagnosable.

5. Run, read failures, iterate:

  ```bash
  go test ./pkg/parser/ -run TestParse -v
  pytest tests/test_parser.py -x -q
  npx vitest run src/parser.spec.ts
  ```

  When a test fails, decide which side is wrong. If the code is wrong, report the bug (use the `ask` tool to confirm intended behavior with the user if it is genuinely ambiguous; the `advisor` tool can be consulted for a second opinion on tricky semantics). If the test is wrong, fix the test's setup or expectation to match the documented contract. Never delete an assertion, broaden a matcher (`toEqual` to `toBeTruthy`), or wrap in try/except to get to green — that is falsifying the spec.

## Edge cases

- No framework present: ask before introducing one; default to the stdlib option (`unittest`, `testing`, built-in `node:test`) if the user wants zero new dependencies.
- Nondeterminism (time, random, UUIDs): inject or freeze it (`freezegun`, `jest.useFakeTimers()`, passing a clock); never assert on live time or sleep.
- Heavy constructors or singletons: extract the pure logic and test that; do not boot the world in a unit test.
- Snapshot tests: only for serialized output that humans review; never snapshot objects with timestamps or addresses.
- A "unit" test that needs the network or a real database is an integration test — say so and stop, or hand off to `/skill:integration`.
- If the suite was already red before your changes, record the pre-existing failures first (`git stash` your work, run, unstash) so you only chase failures you caused.

## Done criteria

- Framework and runner detected from the repo, not assumed.
- New tests live where existing ones live and read like them.
- Every targeted function has happy-path, boundary, and error-path cases; every visible branch is exercised.
- Table-driven style used where idiomatic for the language.
- Full relevant test command passes locally; output shown, not paraphrased.
- No assertion was weakened, skipped (`xit`, `@pytest.mark.skip`, `t.Skip`), or deleted to achieve green.
- Any genuine bug found in the code under test is reported separately, not papered over.
