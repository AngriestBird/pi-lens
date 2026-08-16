---
section: Fixed
---

- **Auxiliary LSP scanners reach per-edit diagnostics (closes #1458)** — Auxiliary waits now use each server's declared budget within a 2-second post-primary ceiling, in both the touch push wait and the `getDiagnostics` aggregation lane. Late findings carry into the next unchanged-content read only when their SHA-256 content binding matches. Each touch logs a per-scanner wait outcome (answered, silent, or cut off — decided from evidence of an actual publication, not just promise settlement) with elapsed time and effective budget. Independently diagnosed by @snowyukitty, who reported the same root cause and both affected call sites in #1471.
