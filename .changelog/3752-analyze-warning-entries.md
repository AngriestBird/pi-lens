---
section: Fixed
---

- **`pilens_analyze` lists every finding its counts report (closes #3752)** — The MCP analyze facade counted the dispatcher's warnings bucket (which carries the synthetic `coverage-unavailable` / `coverage-partial` notice) but serialized only `result.diagnostics`, so a Go or PHP file whose only entry was a coverage notice returned `counts.warnings: 1` with `diagnostics: []`. The listed `diagnostics` now merge the warnings bucket in, deduped by dispatch id, so every count has a matching entry.
