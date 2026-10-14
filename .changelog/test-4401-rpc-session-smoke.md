---
section: Changed
audience: internal
---

- The install smoke's RPC check now runs a session the way an RPC child does and reds on any host exit, `extension_error`, warning or error notice, or pi-lens failure log line from start through the first turn (#4401). `scripts/rpc-load-check.mjs` drives `pi --mode rpc` against a local fake provider, waits for the warm-up and sends a prompt. `host-range-smoke` also runs it on the packed tarball with the snapshot persist worker forced to fail (`PI_LENS_TEST_SNAPSHOT_WORKER_FAIL`, a test-only seam in the worker), the #4400 shape. The old check passed #4314 because a failed warm is only a log line.
