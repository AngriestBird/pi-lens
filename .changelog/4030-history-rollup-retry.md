---
section: Fixed
audience: internal
---

- The nightly test-history rollup ingests every CI run after its watermark (whole runs, at most 150 a night), stores daily per-test aggregates instead of raw rows (about 17 MB for 90 days instead of about 15 MB a day), migrates the raw journal once with a streamed read, retries transient artifact-download 5xx responses, publishes only from schedule or master, and files a tracking issue on a red night.
