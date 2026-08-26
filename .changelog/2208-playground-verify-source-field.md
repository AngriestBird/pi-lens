---
section: Fixed
---

- **Fix `playground-verify-rule.mjs` matching the wrong source (closes #2208)** — the harness wrote a caller's `--code` into the upstream ast-grep playground's `query` field, which only feeds its Pattern mode. Config mode (what this harness always uses) matches against `state.source` instead, so the URL hash carried no source and the playground silently fell back to its own hardcoded sample. Every run graded that fixed sample, not the caller's code, so `matches` never reflected the fixture under test. `source` now carries the code; a rule + known-matching snippet reports a real match count instead of a silent 0.
