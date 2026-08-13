---
section: Added
---

- **Deterministic LSP acquisition-race coverage (refs #1292)** — concurrent initialization and an aborted waiter now assert single-client ownership, zero leaked leases, and teardown reaping through the shared interleaving kit.
