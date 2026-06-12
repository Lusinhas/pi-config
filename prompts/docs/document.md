---
description: Write or refresh documentation for a topic, matching the existing docs style
argument-hint: <feature, module, or path>
---

Write or refresh the documentation for $@.

Study existing docs first: find the documentation home (docs/, README.md, doc comments, a handbook folder) and read two or three representative pages to absorb the house style — heading depth, tone, code-fence language tags, admonition syntax, link conventions, how examples are presented. Match that style exactly; do not introduce a new format.

Then read the actual implementation of $@ so the docs describe current behavior rather than remembered behavior: public API surface, parameters and their defaults, error cases, configuration knobs. If docs already exist, update them in place — fix stale claims, dead links, renamed flags — preserving structure and anchors others may link to; restructure only if the current page is actively misleading.

Include at least one runnable, copy-pasteable example verified against the real code. Document the why behind non-obvious design choices, not just the what. Keep coverage proportionate: what users need, not internals nobody calls. Finish by listing the files created or changed and any claims you could not verify.
