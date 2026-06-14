---
name: integration
description: "Builds and stabilizes integration tests across seams (databases, HTTP, caches, queues), preferring real dependencies via containers. Use to test component interactions or de-flake a suite."
disable-model-invocation: true
---

Integration tests buy confidence that units compose: the query actually runs, the HTTP client actually parses the real response shape, the queue consumer actually acks. They are slower and flakier than unit tests by nature, so the job is to maximize fidelity per second of runtime and drive flakiness to zero by construction.

## Workflow

1. Map the seams. Identify what the code under test talks to: database, HTTP APIs, message broker, filesystem, cache, clock. Use `astsearch` to find client construction sites (`NewClient`, `createPool`, `boto3.client`) if available, otherwise:

  ```bash
  grep -rnE 'pg.Pool|create_engine|redis.Redis|amqp|kafka|http.Client|fetch\(' src/ --include='*.ts' --include='*.py' --include='*.go'
  ls docker-compose*.yml compose*.yaml Tiltfile 2>/dev/null
  ```

2. Choose the dependency strategy, in strict preference order:
  - Existing `docker-compose.test.yml` or testcontainers usage in the repo: reuse it exactly.
  - Docker available (`docker info` succeeds): testcontainers (`testcontainers` for Python/Node/Go/Java) for per-test isolated instances, or `docker compose up -d --wait` for a shared stack.
  - No Docker: high-fidelity fakes only — in-memory implementations of the same interface (SQLite only if the production dialect differences are irrelevant to the queries under test), recorded HTTP via VCR/nock/responses with real captured fixtures, embedded brokers. Never hand-rolled mocks that return whatever the test wants; the fake must enforce the real contract (status codes, error shapes, ordering).
  - External APIs you do not own: always recorded/replayed, never live in CI.

3. Make setup and teardown idempotent. Every fixture must be safe to run twice and safe after a crashed previous run:
  - Unique-per-run namespaces: schema per test run (`CREATE SCHEMA test_$RANDOM`), random queue names, `mktemp -d` for files.
  - Teardown in reverse order, tolerant of partial setup (`DROP SCHEMA IF EXISTS ... CASCADE`, `docker compose down -v --remove-orphans`).
  - Migrations applied by the fixture itself, not assumed.

  ```bash
  docker compose -f docker-compose.test.yml up -d --wait
  pytest tests/integration -m integration; status=$?
  docker compose -f docker-compose.test.yml down -v --remove-orphans
  exit $status
  ```

4. Tag slow tests so the default loop stays fast: `@pytest.mark.integration` plus `markers` registered in `pyproject.toml`, Go build tags (`//go:build integration`) or `testing.Short()` guards, jest: a separate config or `--testPathPattern(s)=integration` (a file-path filter, not a name filter), vitest: positional path filters or a separate config/project. Document the invocation in the test file header. Track multi-step setup work with the `todo` tool if available.

5. Run and stabilize. Run the new tests at least three times in a row before declaring victory:

  ```bash
  for i in 1 2 3; do pytest tests/integration -m integration -x || exit 1; done
  go test -tags integration -count=3 ./internal/store/
  ```

  When a test flakes, find the root cause — never add retries or sleeps as the fix. The usual suspects, in order of likelihood: asserting before an async operation completes (fix: poll for the condition with a deadline, or use the system's own readiness signal), shared state between tests (fix: unique namespaces from step 3), port collisions (fix: bind port 0 / let testcontainers assign), reliance on wall-clock ordering (fix: inject the clock), container not ready despite "started" (fix: health-check-based waits, not fixed sleeps). The `task` tool can be used to bisect a flaky interaction in a parallel session; `websearch` helps when a container image's readiness semantics are undocumented.

## Edge cases

- Docker present but daemon unreachable (CI sandboxes, rootless setups): detect with `docker info` and fall back to fakes rather than failing the suite confusingly.
- Tests that mutate global dev infrastructure (shared staging DB): refuse; isolate first.
- Data-dependent tests: seed explicitly inside the test, never depend on leftover rows.
- Parallel runners: assume tests run concurrently; anything shared needs the unique-namespace treatment.
- A test failing only in CI: capture container logs in teardown (`docker compose logs > artifacts/compose.log`) before `down -v` destroys them.

## Done criteria

- Every external seam is exercised against a real dependency or an explicitly justified high-fidelity fake.
- Setup is self-contained, idempotent, and survives a dirty previous run; teardown removes everything including volumes.
- Slow tests are tagged and excluded from the default fast loop; the exact command to run them is documented.
- New and touched tests pass three consecutive runs with no retries configured.
- Any flake encountered was fixed at the root cause, with the cause named in the commit or summary.
- No live calls to third-party APIs remain in the suite.
