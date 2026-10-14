---
section: Fixed
audience: user
---

- **Marked findings stay hidden on every diagnostics route, and hidden ones are counted (#1634)** — a finding marked false-positive or won't-fix with `lens_diagnostic_mark` still came back from `lsp_navigation workspaceDiagnostics` (with or without a path) and from `pilens_project_scan` over MCP. Both now apply the same finding policy as `lens_diagnostics` and say how many findings it hid, and `lsp_navigation`'s no-path snapshot gives each file's age (`scanned 5m ago`), since it replays what each language server last reported. `lens_diagnostics mode=all` now states how many findings marks hide in its scope instead of reading "No issues ✓" right after a `mode=full` listed them.
