---
section: Fixed
---

- **Diagnostic pulls no longer dispatch once the caller's budget is
  exhausted** — `textDocument/diagnostic` and `workspace/diagnostic` pulls
  used to send an unwinnable 1ms request when the remaining budget was 0 or
  negative, then log it as a genuine timeout. Below a 5ms usable floor the
  pull is skipped outright and recorded as
  `lsp_pull_skipped_budget_exhausted`, so `lsp_pull_diagnostic_timeout` only
  ever means a pull was really attempted (#1773).
- **A pull timeout's abandoned request now traces server rejections, not
  just late answers** — when an abandoned pull rejects (for example a
  permanent server error after the caller gave up) instead of answering or
  staying silent, it now emits a bounded `lsp_pull_late_rejection` record
  with the error code and elapsed time. The rejection is still swallowed;
  only the observability changes (#1774).
- **Genuine pull timeouts now count in the degradation ledger** —
  `lsp_pull_diagnostic_timeout` previously wrote a detailed latency.log
  record but tallied nothing, so a storming server was invisible in
  aggregate. It now increments `lsp-pull-diagnostic-timeout` with a subject
  that preserves server and file identity (#1771).
