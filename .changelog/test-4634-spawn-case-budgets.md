---
section: Fixed
audience: internal
---

- **Wall-clock budgets scale with the host's load (#4634)** — Every case in
  `tests/tools/diagnostics-route-switch-matrix.test.ts` now carries an explicit
  `scaledTestTimeout` budget instead of vitest's 5 s default, the matrix's
  write-time cell judges only the latency reports its own writes produced, and
  the mkdtemp whole-tree scan in `tests/config/tmp-fixture-hygiene.test.ts` takes
  60 s. The `default` Vitest project declares the 60 s `hookTimeout` its six
  sibling projects already use, which ends the 10 s `beforeAll` ceiling a
  whole-`clients/` scan red on. No product behaviour changes.
