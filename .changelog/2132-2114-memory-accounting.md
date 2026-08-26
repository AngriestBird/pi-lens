---
section: Changed
---

- **Bound memory accounting (refs #2132, #2114)** — Add measured byte estimates for review-graph and dispatch-cache residency to `memory_sample`, and keep the word-index persistence hook visible in sampler coverage. #2132 criterion 3 remains undelivered; the `runtime.wordIndex` to `memory_sample` seam can still report `wordIndex:null` and remains a named follow-up.
