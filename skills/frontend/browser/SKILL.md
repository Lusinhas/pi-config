---
name: browser
description: "Drives a real browser via the Playwright CLI to navigate, screenshot, and assert against live pages. Use when a frontend change needs visual or in-browser verification."
disable-model-invocation: true
---

Verify frontend work by looking at it. This skill runs everything through `bash`, `write`, and `read` — Playwright is a dev dependency driven by disposable scripts, not an agent capability — so it works even when every extension is disabled.

## Workflow

1. Preflight. From the project root:

  ```bash
  node -v && npx playwright --version
  ```

  If Playwright is missing, prefer a local dev install so scripts can resolve it: `npm i -D playwright` (or the project's package manager: `pnpm add -D playwright`, `bun add -d playwright`). Then ensure a browser binary exists: `npx playwright install chromium` (~150 MB, one-time). If the download is blocked or system libraries are missing and `npx playwright install-deps chromium` is impossible without sudo, fall back to the system browser: `chromium.launch({ channel: 'chrome' })` or `executablePath: '/usr/bin/chromium'`.
2. Scratch space. Put screenshots in `mktemp -d /tmp/pw-shots.XXXXXX`. Put scripts in `node_modules/.pw-scratch/` inside the project — ESM bare imports resolve from the script's own path, so a script in `/tmp` cannot find the project's `playwright` package, while one under `node_modules/` resolves it and is gitignored for free:

  ```bash
  SHOTS=$(mktemp -d /tmp/pw-shots.XXXXXX) && mkdir -p node_modules/.pw-scratch
  ```

3. Dev server. Check whether one is already listening before starting anything (`ss -ltn | grep -E ':(3000|5173|8080)'` or `curl -fsS http://localhost:5173 -o /dev/null`). If you must start it, record the PID and poll until ready:

  ```bash
  setsid npm run dev >/tmp/dev.log 2>&1 & echo $! >/tmp/dev.pid
  for i in $(seq 1 60); do curl -fsS http://localhost:5173 -o /dev/null && break; sleep 1; done
  ```

  Read `/tmp/dev.log` if the loop times out — Vite and Next print the actual port there and will silently pick a different one when the default is taken. The `webfetch` tool (or `curl -s ... | head -5`) is a cheap sanity check that the URL returns HTML before paying browser startup cost.
4. Script. Write a single-purpose `.mjs` file, run it, delete it. Template:

  ```js
  import { chromium } from 'playwright';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:5173/', { waitUntil: 'load' });
  await page.waitForSelector('#root > *', { timeout: 10000 });
  await page.screenshot({ path: process.env.SHOTS + '/home.png', fullPage: true });
  if (errors.length) { console.error('CONSOLE ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
  await browser.close();
  ```

  ```bash
  SHOTS=/tmp/pw-shots.XXXXXX node node_modules/.pw-scratch/shot.mjs   # paste the real dir from step 2 — shell state does not persist between bash calls
  ```

  Adapt per task: `page.setViewportSize({ width: 375, height: 812 })` for responsive checks, `page.click()` / `page.fill()` / `page.keyboard.press('Tab')` for interactions, plain `if`-checks with a nonzero `process.exitCode` for assertions — do not pull in `@playwright/test` for throwaway work.
5. Inspect. Open each PNG with the `read` tool (it renders images) and judge the actual pixels: layout, overlap, clipped text, blank regions. Always report captured console errors alongside the visual verdict. For multi-page or multi-viewport matrices, track coverage with the `todo` tool if available; if the user should keep a screenshot, copy it to a persistent path (e.g. the project root or `~/`) and report that path, otherwise tell them the `/tmp` location.
6. Cleanup, even on failure:

  ```bash
  kill -- -"$(cat /tmp/dev.pid)" 2>/dev/null; rm -f /tmp/dev.pid /tmp/dev.log
  rm -rf node_modules/.pw-scratch "$SHOTS"
  ```

  Never kill a server you did not start (`setsid` in step 3 made the dev server its own process group, so the group kill cannot take out anything else). If a script crashed before `browser.close()`, sweep orphans with `pkill -f 'headless_shell|chrome.*--headless' 2>/dev/null`. If this skill added `playwright` to the project, report the `package.json`/lockfile change and ask whether to keep or revert it.

## Edge cases

- Avoid `waitUntil: 'networkidle'` on dev servers — HMR websockets and polling keep it from settling; wait for a concrete selector instead.
- A full-screen Vite/Next error overlay means a build error, not a styling bug: check `page.locator('vite-error-overlay')` or read the dev log before trusting any screenshot.
- Auth-gated pages: script the login form once, save the session with `page.context().storageState({ path: '/tmp/auth.json' })`, and reuse it in later scripts via `browser.newContext({ storageState: '/tmp/auth.json' })` — no persistent context needed.
- Animations cause flaky pixels: pass `animations: 'disabled'` to `screenshot()` or wait for `page.evaluate(() => document.fonts.ready)` plus a short settle.
- CI-like sandboxes without GPU/sandbox support: `chromium.launch({ args: ['--no-sandbox'] })`.
- Current Playwright requires Node 18+; if `node -v` is older, upgrade Node rather than working around it.

## Done when

- [ ] Playwright resolved and a browser binary launches without error
- [ ] Target pages screenshotted at every viewport the task required, images actually read and judged
- [ ] Console and page errors captured and reported, not just screenshots
- [ ] Any assertion scripts exited 0 (or failures explained to the user)
- [ ] Spawned dev server killed only if this skill started it; scratch scripts and shots deleted
