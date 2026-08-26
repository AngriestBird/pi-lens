---
section: Added
---

- **Classify a red Unit tests run as infra-oom, infra-net, or real (refs #2103)** — `scripts/classify-ci-failure.mjs` reads a failed job's log, tells an OOM kill (with or without the `with-memory-watch.mjs` wrapper surviving to report it) and a DNS/network failure apart from a genuine assertion failure, posts one sticky PR comment naming the verdict, and reruns the failed jobs once per head SHA when the verdict is infra. A real failure is never rerun and never labeled infra.
