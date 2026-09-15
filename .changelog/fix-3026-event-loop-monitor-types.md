---
section: Fixed
---

- **Compile against `@types/node` 26.5.1 (refs #3026)** — `node:perf_hooks` no longer exports the `IntervalHistogram` type, which broke `tsc` (TS2305) and with it every CI lane that builds. The event-loop monitor now infers the histogram type from `monitorEventLoopDelay`; emitted JavaScript and runtime behaviour are unchanged.
