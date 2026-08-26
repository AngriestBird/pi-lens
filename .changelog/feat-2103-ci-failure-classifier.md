---
section: Added
---

- **Classify a red Unit tests run as infra-oom, infra-net, or real (refs #2103)** — `scripts/classify-ci-failure.mjs` reads a failed job's log, tells an OOM kill (with or without the `with-memory-watch.mjs` wrapper surviving to report it) and a DNS/network failure apart from a genuine assertion failure, posts one sticky PR comment naming the verdict, and reruns the failed jobs once per head SHA when the verdict is infra. Every recognized real-failure shape (a FAIL block, an inline test-failure marker, a file-level collection error, or the overall failed-test tally) wins over any infra signal in the same log, and an unrecognized shape defaults to real rather than infra — the classifier is only as good as the shapes it recognizes, so treat "real" as the safe default, not an absolute guarantee against every possible log shape.
