---
section: Fixed
---

- **Diagnostic pulls no longer dispatch once the caller's budget is exhausted (#1773)** — `textDocument/diagnostic` and `workspace/diagnostic` pulls used to send an unwinnable 1ms request when the remaining budget was 0 or negative, then log it as a genuine timeout. Below a 5ms usable floor the pull is skipped outright and recorded as `lsp_pull_skipped_budget_exhausted`, so `lsp_pull_diagnostic_timeout` only ever means a pull was really attempted.
