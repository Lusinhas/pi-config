---
name: verify
description: "Verifies a change by running the app and observing the changed behavior end to end, with captured evidence. Use when tests alone are not proof or before claiming a change works."
disable-model-invocation: true
---

Tests passing is not the same as the change working. This skill proves a change by running the real program and observing the changed path, then leaves the machine clean. Never claim verification without captured evidence (command output, HTTP response, screenshot, or log line).

## Workflow

1. **Find the run command, in priority order:**
   - A project skill or AGENTS.md note that documents how to launch the app — use it verbatim.
   - `package.json` scripts (`dev`, `start`, `serve`), `Makefile` targets (`make run`), `Procfile`, `docker-compose.yml`, `manage.py runserver`, `cargo run`, `go run ./cmd/...`.

     ```bash
     cat package.json | python3 -c "import json,sys; print(json.load(sys.stdin).get('scripts'))"
     grep -E "^[a-z-]+:" Makefile
     ```

   - README quickstart section as a last resort. If nothing is found and the entrypoint is ambiguous, use the `ask` tool to confirm with the user rather than guessing; without `ask`, state the assumption explicitly and proceed with the most conventional command.

2. **Establish the baseline (before).** If feasible, run the *unchanged* code first and capture current behavior:

   ```bash
   git stash
   npm run dev > /tmp/app-before.log 2>&1 & pid=$!
   for i in $(seq 1 30); do curl -sf http://localhost:3000/healthz && break; sleep 1; done
   curl -s http://localhost:3000/api/users/42 | tee /tmp/before.json
   kill $pid; git stash pop
   ```

   Skip the baseline only when the change adds something that previously did not exist (a 404 is itself the baseline evidence).

3. **Start the app with the change.** Prefer the suite's background jobs tool when available so the process is tracked and auto-reaped. Fallback with plain bash:

   ```bash
   npm run dev > /tmp/app.log 2>&1 &
   echo $! > /tmp/app.pid
   for i in $(seq 1 30); do curl -sf http://localhost:3000/healthz && break; sleep 1; done
   ```

   Poll readiness; never `sleep 10` blindly. If startup fails, read `/tmp/app.log` *before* touching code — most failures are ports, env vars, or missing migrations, not your change.

4. **Drive the changed path specifically.** Exercise the exact behavior the diff touches, not the homepage:
   - HTTP: `curl -s -X POST http://localhost:3000/api/import -H "Content-Type: text/csv" --data-binary @fixtures/bom.csv -w "\n%{http_code}\n"`
   - CLI: invoke the built binary with the new flag and a realistic argument.
   - UI: use the browser skill to load the page, perform the interaction, and screenshot; without it, verify the API/template layer with curl and grep the served HTML.
   - Watch the log concurrently: `tail -n 50 /tmp/app.log` after each request.

5. **Capture after-evidence and diff it against the baseline.**

   ```bash
   curl -s http://localhost:3000/api/users/42 | tee /tmp/after.json
   diff /tmp/before.json /tmp/after.json
   ```

   Evidence must show the *delta* the change promises. Leave evidence files (screenshots, response bodies) in `/tmp`, name their paths, and quote the decisive lines in your summary.

6. **Clean up.** Kill what you started, and only what you started:

   ```bash
   kill "$(cat /tmp/app.pid)" 2>/dev/null
   sleep 1 && kill -9 "$(cat /tmp/app.pid)" 2>/dev/null || true
   ```

   Avoid `pkill -f node` — it can kill the user's editor tooling. Confirm the port is free: `ss -ltn | grep 3000 || echo released`. Revert any temporary config or seeded data.

## Edge cases

- **Port already in use:** something is already running — check `ss -ltnp | grep 3000`. Prefer an alternate port via env (`PORT=3987 npm run dev`) over killing an unknown process.
- **Needs a database/secret:** look for `docker-compose.yml` services or `.env.example`; if a real secret is required, verify up to the boundary (assert the request reaches the right handler with the right payload) and report exactly what could not be exercised.
- **Long-running build before start:** run the build as its own foreground step first so failures are attributable, then start the server.
- **Behavior is time- or state-dependent:** seed the state explicitly (fixture script, SQL insert) and document the seeding in the summary.
- **Verification fails:** that is a successful outcome of this skill — report the discrepancy with evidence, do not rationalize it away or weaken the check.

## Done when

- [ ] Run command discovered from project metadata, not guessed silently
- [ ] App started, readiness confirmed by polling, startup log checked
- [ ] The specific changed path was exercised with a concrete request/invocation
- [ ] Evidence captured for after (and before, where applicable), and quoted in the summary
- [ ] All started processes killed and ports confirmed released
- [ ] Verdict stated plainly: works as intended, or fails with the observed delta
