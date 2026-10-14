---
section: Fixed
audience: user
---

- **A malformed persist worker message no longer ends pi (#4402)** — The project-snapshot and review-graph persist hosts read a worker result only through `readGzipStageWorkerResult`. A message they cannot route, or whose handling threw, is counted as `persist-worker-message-contained` in the degradation ledger, and a result with a wrongly typed field takes the main-thread write. The persist worker answers a malformed request with an error result instead of dying. `tests/clients/worker-message-boundary-ratchet.test.ts` reds on any `message` handler in `clients/`, `mcp/`, `tools/` or `index.ts` whose parameter is not `unknown` or whose body is not one non-rethrowing `try`. `tests/clients/persist-worker-message-fault-injection.test.ts` sends malformed, error-shaped and foreign messages through the real `Worker`.
