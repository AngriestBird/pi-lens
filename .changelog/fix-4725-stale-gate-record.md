---
section: Fixed
audience: user
---

- **`--lens-guard` no longer refuses every commit over a record an earlier session left (#4725)** —
  a `turn-end-findings` record past the cache's freshness window, or written by
  another session, refused every later commit as "blocker state is unknown",
  and the refusal's "start a fresh session" did not help. A record that claims
  no blocker no longer gates at any age, and a clean write or a settled turn end
  retires it; so does a turn end for the record a session without
  `--lens-guard` left. A record that still carries a blocker keeps gating, and
  the refusal now names its files: a write that pi-lens checks in full and
  finds clean clears that file's part, and the last one clears the record. A
  passing test run no longer takes over another session's record, so its
  blockers stay until their files are checked.
