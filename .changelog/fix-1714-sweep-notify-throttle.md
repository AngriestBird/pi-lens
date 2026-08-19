### Fixed

- A `lens_diagnostics mode=full` sweep no longer hands an auxiliary scanner more
  documents than it can read. Each auxiliary now holds a bounded number of
  unacknowledged `didOpen` notifies; past that, the next notify waits for a
  request round-trip to prove the server drained its input. A file the throttle
  holds back is reported as uncovered rather than dropped, so it stays in the
  sweep's coverage gap. The ceiling is tunable per server class
  (`LSPServerInfo.notifyInflightLimit`, default 8, ast-grep 4) and globally via
  `PI_LENS_LSP_AUX_NOTIFY_INFLIGHT`. (#1714)
