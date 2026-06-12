---
description: "Generate changelog entries since a given ref (default: the last tag)"
argument-hint: "[since-ref]"
---

Generate changelog entries covering every commit since ${1:-the last tag}.

Resolve the range: if a ref was given, use `<ref>..HEAD`; otherwise find the last tag with `git describe --tags --abbrev=0` and use `<tag>..HEAD` (if no tags exist, fall back to full history and say so). List commits with `git log --no-merges --pretty='%h %s (%an)' <range>` and inspect the diffs of unclear commits rather than guessing from subject lines.

Group entries under Keep-a-Changelog-style headings — Added, Changed, Fixed, Deprecated, Removed, Security — but match the headings and tone of an existing CHANGELOG.md if one is present. Write each entry as one user-facing sentence describing the effect, not the implementation; merge multi-commit features into a single entry and drop pure chores (CI, formatting, lockfile churn) unless user-visible. Mark breaking changes with **BREAKING** at the front of the entry. Carry over PR or issue numbers that appear in commit subjects.

Output the entries as a markdown section ready to paste under a new version heading. Do not edit any files unless explicitly asked.
