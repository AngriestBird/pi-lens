---
section: Changed
---

- **Cooperative-budget acceptance coverage hardened (closes #1215)** — the shared time-budget helper's occupancy and abort-latency guarantees are now locked by non-vacuous regression tests at 800-item scale (assertions within a small multiple of the budget); no runtime behavior change.
