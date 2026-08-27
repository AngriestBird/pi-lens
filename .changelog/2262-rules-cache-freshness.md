---
section: Fixed
---

- **Ast-grep YAML rule caches detect edited and nested files (closes #2262)** — the in-memory rules cache snapshots every YAML file with `mtimeMs` and size, then confirms content when metadata agrees. Editing an existing rule or adding a nested rule therefore invalidates the cache even when the rule directory mtime stays unchanged.
