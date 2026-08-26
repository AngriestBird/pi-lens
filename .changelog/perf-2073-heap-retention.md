---
section: Fixed
---

- **Prove idle-eviction replacements release graph memory (refs #2073)** — Add a forced-GC benchmark for twenty 2,000-file-sized workspace graph replacements. The cache retains under 10 MiB after replacement, proving outgoing eviction timers do not retain prior graphs.
