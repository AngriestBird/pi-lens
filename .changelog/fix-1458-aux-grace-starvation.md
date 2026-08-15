---
section: Fixed
---

- **Auxiliary LSP scanners reach per-edit diagnostics (closes #1458)** — Auxiliary waits now use each server's declared budget within a 2-second post-primary ceiling. Late findings carry into the next unchanged-content read only when their SHA-256 content binding matches, and each touch logs settled and starved scanner outcomes with elapsed time and effective budgets.
