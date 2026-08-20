---
section: Fixed
---

- **Genuine pull timeouts now count in the degradation ledger (#1771)** — `lsp_pull_diagnostic_timeout` previously wrote a detailed latency.log record but tallied nothing, so a storming server was invisible in aggregate. It now increments `lsp-pull-diagnostic-timeout` with a subject that preserves server and file identity.
