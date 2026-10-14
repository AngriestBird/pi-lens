---
section: Changed
audience: internal
---

- Every worker `message` listener now checks the message's shape and keeps a throw inside itself (#4402, recurrence #4400). The project-snapshot and review-graph persist hosts read a worker result only through `readGzipStageWorkerResult`, count a message they cannot route or whose handling threw as `persist-worker-message-contained` in the degradation ledger, and route a result with a wrongly typed field to the main-thread write. The persist worker answers a malformed request with an error result instead of dying. `tests/clients/worker-message-boundary-ratchet.test.ts` reds on any `message` handler in `clients/`, `mcp/`, `tools/` or `index.ts` whose parameter is not `unknown` or whose body is not one non-rethrowing `try`, and `tests/clients/persist-worker-message-fault-injection.test.ts` sends malformed, error-shaped and foreign messages through the real `Worker`.
