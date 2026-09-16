---
section: Fixed
---

- **Re-arm the tree-sitter query parse-failure record every session (refs #3070)** — `TreeSitterQueryLoader.loadQueries` short-circuited on its `loaded`/`loadedRoot` memo before re-parsing, so a broken custom rule's `tree-sitter-query-parse-failed` degradation record only ever reached the first session that parsed it; the shared loader instance is deliberately kept across sessions, so every later session's `resetDegradationLedger()` silently dropped the row to zero. Per-file parse failures are now remembered and replayed once per ledger generation on a memoized reload, and cleared whenever a rule is actually re-parsed so a fix on disk stops replaying a stale failure. Also adds regression coverage for the existing `str()` guard against a mapping-valued `message` field, which had none.
