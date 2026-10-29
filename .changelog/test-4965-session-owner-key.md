---
section: Changed
audience: internal
---

- Every session-state registry entry now names its owner key (`session`, `repository`, `project` or `process-wide: <reason>`), the coordinator's per-turn warnings, the cache observability's per-session state and the memory sampler's pending turn end moved onto scope cells that end with their session's scope (reached by session id through `sessionCell`), and the conformance test refuses a `session` owner that states no reason a scope cell cannot hold it (defect shape 72, refs #4965).
