---
section: Fixed
---

- **LSP teardown: live-wedged proof, precise failure attribution, and idempotent shutdown (refs #1620)** — closes out the residuals from #1624's bounded `clientShutdown` fix. Adds a real-child-process fixture (`FAKE_LSP_WEDGE_STDIN_AFTER_INIT`) proving the bound holds against a genuinely wedged OS pipe, not just a mocked connection — the prior unit-level test alone did not exercise real pipe backpressure. `lsp_client_shutdown` now distinguishes an actual timeout from an immediate rejection (`shutdownRequestRejected`/`exitNotifyRejected`, alongside the existing `*TimedOut` pair) instead of folding both into the same flag. `clientShutdown` is now idempotent: two callers racing to shut down the same client (8 call sites can race the same state) share one teardown and one log record instead of each running the RPC handshake and inflating any `shutdownOutcome: "forced"` count read from the log.
