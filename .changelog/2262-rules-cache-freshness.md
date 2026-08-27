---
section: Fixed
---

- **Ast-grep YAML rule caches detect edited and nested files (closes #2262)** — the in-memory rules cache snapshots every YAML file with `mtimeMs` and size, re-checked at most once per 2-second cadence window. Editing an existing rule or adding a nested rule invalidates the cache even when the rule directory mtime stays unchanged; pickup lag is bounded by one cadence window.
