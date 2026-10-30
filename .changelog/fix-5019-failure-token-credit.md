---
section: Fixed
audience: internal
---

- **PR body lint: a re-spelled failure token is not a new failure path (#5019)** — the Observability failure-path scan credits a hunk's removed `catch`, `throw`, `return null` or `recordDegradationOnce` against that hunk's additions of the same kind, compares per token kind and per hunk (never per file), and lexes the reconstructed pre-image so a token inside a removed comment or string credits nothing. A body that only re-spells the condition in front of an existing `return null` now passes `pr-body.sh`, and an addition with no removed counterpart still refuses.
