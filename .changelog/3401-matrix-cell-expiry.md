---
section: Fixed
---

- **Stale LSP capability-matrix cells expire, and a tier change needs two agreeing nightly runs (#3401)** — A `first-publish` cell the nightly probe no longer observes now degrades to `unknown` after five consecutive runs instead of surviving forever, and a `clean-behavior`/`tier` change is written only after two consecutive runs observe the same new value, so a single flapping run (ast-grep went 2 → 2* → 3 → 2*) cannot rewrite a cell. The counters live in a generated section of `docs/lsp-capability-matrix.md`, the only state the refresh persists across runs.
