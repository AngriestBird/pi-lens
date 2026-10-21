---
section: Changed
audience: internal
---

- **Session-identity tests moved from the pi double onto the real host (#4632 slice 5)** —
  `tests/index-4632-s5-session-identity.test.ts` now runs the shared-teardown, per-root
  `session_start` and config-resolution-at-the-boundary cases as real pi `AgentSession`s
  (`tests/support/pi-session.ts`), asserting pi's own session ids, the process registry and the
  loaded copy's own log rows. The old `tests/index-config-resolved-session-wiring.test.ts` is
  deleted with its `pi-mock` row; the two other files keep the cases whose verdict needs the
  double (an activation with several live members, a replacement ordering pi never produces, and
  `vi.mock` interposition) and their rows now name that class. The tier-2 helper also pins
  `minimal` as a startup mode and a second live session as a concurrent secondary. No product
  behaviour changes.
