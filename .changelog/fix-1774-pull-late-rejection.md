---
section: Fixed
---

- **A pull timeout's abandoned request now traces server rejections, not just late answers (#1774)** — when an abandoned pull rejects (for example a permanent server error after the caller gave up) instead of answering or staying silent, it now emits a bounded `lsp_pull_late_rejection` record with the error code and elapsed time. The rejection is still swallowed; only the observability changes.
