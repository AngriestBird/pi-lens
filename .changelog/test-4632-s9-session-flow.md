---
section: Changed
audience: internal
---

- **Four session-flow test files lost or narrowed their hand-built pi double (#4632 slice 9)** —
  `tests/index-2992-integration.test.ts` moved all three host cases onto tier 2: pi's own
  `ExtensionRunner.invalidate()` supplies the stale ctx, and the loaded copy's `extension-ctx-stale`
  and `io-bridge-read-dropped` records are read back from the `latency.log` the copy wrote, so its
  `pi-mock` row is deleted. `tests/index-session-start-classification-wiring.test.ts` now runs a
  same-root replacement and a refused different-root start through real sessions, replacing the
  double's mutated-ctx replay and the `pi-mock` row's class is `unproducible-payload`. The
  `lens-toggle-command` registration case runs on tier 1 against the host's own command registry, and
  `tests/index-lsp-config-root-eviction.test.ts` keeps its row with the class `internal-seam`. No
  product behaviour changes.
