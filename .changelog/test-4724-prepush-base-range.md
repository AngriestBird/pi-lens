---
section: Changed
audience: internal
---

- **The pre-push hook selects tests for the branch's own change (#4724)** — Each
  pushed ref now diffs against the base branch instead of the remote tip, so a
  master merge onto a pull-request branch no longer counts master's files as the
  branch's own (#4557's merge selected 366 test files for an 11-file change). The
  base is `upstream/master` when it has commits `origin/master` lacks, as on a
  fork with a lagging master, and `origin/master` otherwise. A re-push of a head
  whose record shows the tests passed in a clean checkout of exactly that head
  skips the build and tests, and an unresolvable base falls back to the remote-tip
  range instead of selecting nothing. The
  12 armed real-harness suites and `diagnostics-route-switch-matrix` move to the
  CI-only tier: each runs one file at a time, and together they took the whole
  120 s budget on any push. They still run in `Unit tests` and in
  `Targeted tests (advisory)`.
