---
section: Fixed
---

- **Keep event-loop monitoring compatible with current Node types (refs #3026)** — infer the histogram type from `monitorEventLoopDelay` so the runtime monitor remains available when `@types/node` no longer exports `IntervalHistogram`.
