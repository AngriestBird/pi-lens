---
section: Fixed
---

- **Full-scan sweeps no longer out-run an auxiliary scanner (refs #1714)** — A
  `lens_diagnostics mode=full` sweep used to hand a single-threaded scanner more
  documents than it could read, which stalled ast-grep and forced a kill. Each
  auxiliary now holds a bounded number of unacknowledged `didOpen` notifies; past
  that, the next notify waits for a request round-trip proving the server drained
  its input. A file the throttle holds back is reported as uncovered rather than
  dropped, so it stays in the sweep's coverage gap. Tunable per server class via
  `LSPServerInfo.notifyInflightLimit` (default 8, ast-grep 4) and globally via
  `PI_LENS_LSP_AUX_NOTIFY_INFLIGHT`.
