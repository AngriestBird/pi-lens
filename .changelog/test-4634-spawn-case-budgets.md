---
section: Fixed
audience: internal
---

- **Spawn-heavy test cases take a lane-scaled budget (#4634)** — Every case in
  `tests/tools/diagnostics-route-switch-matrix.test.ts` now carries an explicit
  `scaledTestTimeout` budget instead of vitest's 5 s default, and the matrix's
  write-time cell judges only the latency reports its own writes produced. The
  same budget is added to the one `service-project-trust` case measured within
  2.6x of the default. No product behaviour changes.
