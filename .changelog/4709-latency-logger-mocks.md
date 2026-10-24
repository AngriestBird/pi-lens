---
section: Changed
audience: internal
---

- **Twenty test files drop the `clients/latency-logger` mock they never read (#4709).** Test mode skips the latency writer (`logLatency` only updates its in-memory phase ring), so a file that never reads the stub or its sinks runs against the real module; the in-process-mock baseline falls from 816 to 796 rows. The 134 files that still read or drive the stub stay mocked.
