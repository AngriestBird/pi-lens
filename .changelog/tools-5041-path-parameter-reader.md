---
section: Fixed
audience: user
---

- **`path` is the one single-file parameter, and `paths` behaves the same on every tool**: `pilens_module_report {path}`, `pilens_diagnostics {file}` and `pilens_analyze {path}` now run instead of being refused or silently answering for the whole default scope, `effective_config` and `lens_diagnostic_mark` accept `path` while keeping their older `file`/`filePath` spellings, a non-string, blank, empty or over-100-entry `paths` list is refused with one message on every tool instead of being dropped, and `symbol_search` now scopes `src`, `./src` and the absolute directory to the same hits and clamps `limit` to `max(1, floor)` (#5041, #5038).
