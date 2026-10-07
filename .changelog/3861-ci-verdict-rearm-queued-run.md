---
section: Fixed
audience: internal
---

- **`scripts/ci-verdict.mjs` now tells operators to wait while the head's `ci.yml` run is queued or in progress, and reserves re-arm advice for a positive no-run answer (refs #3861)** — the absent-required message fired on a head whose `ci.yml` run GitHub had accepted; the run exists and the queue is slow, so re-arm advice was wrong. A registered run reports its id and age with explicit wait guidance; terminal runs direct manual inspection/rerun; unreadable lookup never authorizes re-arm.
