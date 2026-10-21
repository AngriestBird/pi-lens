---
section: Changed
audience: internal
---

- **Dynamic-tooling tests moved from the pi double onto the real host (#4632 slice 6)** —
  `tests/index-4632-s6-dynamic-tooling.test.ts` runs ten of the twelve `#dynamic-tooling` cases
  from `tests/index-wiring.test.ts` as real pi `AgentSession`s (`tests/support/pi-session.ts`):
  pi's own active tool set, the real `pi_lens_activate_tools` round trip, and pi's `new` /
  `resume` / `fork` / `reload` replacements. `tests/support/pi-session.test.ts` gains the
  contract case that pins how the host declares a request's tool loadout (`getActiveTools()`,
  `toolsAdded`, `toolsRemoved`, and the `context_with_system` transcript) before any consumer
  reads it. The feature-detection fallback and a `/new` whose successor names the current
  session file stay on the double, each a payload this host cannot produce; the
  `tools/diagnostics-route-switch-matrix.test.ts` admit row is classified `internal-seam`.
  No product behaviour changes.
