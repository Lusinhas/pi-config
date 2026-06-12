---
name: design
description: "Audits UI for spacing, typography, color, accessibility, responsiveness, and loading/empty/error states, then fixes approved items. Use to polish UI or align screens with a design system."
disable-model-invocation: true
---

Polish existing UI rather than redesign it. The output of this skill is a ranked findings list, explicit approval from the user, and minimal diffs that express every fix in the project's own design tokens — never ad-hoc values.

## Workflow

1. Scope. List the target screens/components and the files behind them. Track the audit matrix (screen x audit pass) with the `todo` tool if available, otherwise keep a plain checklist in your reply.
2. Learn the design system before judging anything. Find the source of truth for tokens:

  ```bash
  ls tailwind.config.* src/styles src/theme* 2>/dev/null
  grep -rnE --include='*.css' '^\s*--[a-zA-Z][a-zA-Z0-9-]*\s*:' src/ | head -30
  grep -rn 'createTheme\|defineConfig\|tokens' src/ --include='*.ts' -l
  ```

  Record the canonical spacing scale, type scale, color palette, radius/shadow set, and breakpoints. Every later recommendation must cite one of these.
3. Consistency pass. Hunt for values that bypass the system:

  ```bash
  grep -rnE '#[0-9a-fA-F]{3,8}\b' src/components --include='*.tsx' --include='*.css' | grep -viE 'token|var\('
  grep -rnE '(margin|padding|gap|font-size)[^;]*:\s*[0-9]+px' src --include='*.css'
  grep -rnE 'style=\{\{' src --include='*.tsx' | head -20
  ```

  With `astsearch` available, query for inline `style` JSX attributes and styled-components template literals instead; it avoids string-match false positives in comments and tests.
4. Accessibility pass, per screen: (a) contrast — extract each foreground/background pair and check WCAG AA (4.5:1 body, 3:1 for >=24px or bold >=18.66px text and UI components); compute luminance with a short `node -e` snippet if no tooling exists. (b) Focus — read the DOM order, confirm it matches visual order, check that `:focus-visible` styles exist and nothing sets `outline: none` without a replacement. (c) Labels — every input has a `<label for>`/`aria-label`, icon-only buttons have accessible names, images have `alt`. (d) Keyboard — dialogs trap focus and close on Escape; custom widgets (dropdowns, tabs) have arrow-key handling and correct roles. Use the `browser` skill to verify Tab order live when a dev server runs.
5. Responsive pass. Audit at 320, 375, 768, 1024, and 1440 px (plus any project-specific breakpoints found in step 2). With the `browser` skill, screenshot each width and read the images; otherwise statically trace media queries and flex/grid rules and flag fixed widths, horizontal overflow risks (`min-width`, unwrapped long strings), and touch targets under 44x44 px.
6. States pass. For every data-driven view, confirm a loading state (skeleton or spinner with reserved space — no layout shift), an empty state (message plus next action, not a blank region), and an error state (human-readable, retryable). Grep for the data hooks and check what renders while pending/rejected.
7. Propose. Output a ranked table: finding, evidence (file:line or screenshot), user impact, effort (S/M/L), and the exact token-based fix. Rank by impact-per-effort; accessibility blockers (contrast failures, keyboard traps, missing labels) always rank above cosmetic items. Get approval via the `ask` tool if available, otherwise present the list and wait for the user's reply. Do not implement unapproved items.
8. Implement approved items with the smallest possible diff. For mechanical replacements across many files use `astrewrite`; otherwise `grep -rln` the offending value and apply targeted `edit` calls. Express every change in tokens (`var(--space-4)`, `gap-4`, `theme.spacing(2)`), never raw hex/px. Re-run step 3's greps to confirm no stragglers, then re-verify visually with the `browser` skill.

## Edge cases

- No design system exists: derive a de-facto one first — count value frequencies (`grep -rhoE '[0-9]+px' src | sort | uniq -c | sort -rn`), propose the dominant scale as tokens, and get sign-off before normalizing to it.
- Dark mode or multiple themes: run the contrast pass once per theme; a pair passing in light mode commonly fails in dark.
- Generated or vendored CSS (`dist/`, `*.min.css`, `node_modules`): exclude from greps and never edit.
- Off-system values that are intentional (third-party widget overrides, brand-locked colors): flag, ask, and leave a code comment if kept.
- Disabled-state contrast: WCAG exempts disabled controls; do not flag them as failures.
- If the fix changes layout meaningfully, show a before/after screenshot pair before calling it done.

## Done when

- [ ] Audit matrix covered: consistency, accessibility, responsive, states for every in-scope screen
- [ ] Findings presented ranked with evidence; user approved a specific subset
- [ ] All approved fixes implemented using existing tokens only; consistency greps come back clean
- [ ] Keyboard walkthrough and contrast checks pass on touched screens
- [ ] No unapproved refactors, no edits outside the agreed scope, build/lint still green
