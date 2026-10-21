---
section: Removed
audience: user
---

- **pi 0.86.1 is the oldest supported pi host; older hosts receive no findings (#4688).**
  pi 0.80–0.85 keep the prompt outside the request an extension can write to and
  never emit `context_with_system`, so since #4644 pi-lens delivered no session
  guidance, turn-end findings, test findings or nudges there, and recorded
  nothing about it. Rather than revive those hosts, the certified window moves
  from `>=0.80.10 <1.4.0` to `>=0.86.1 <1.4.0`. `package.json` keeps its open
  `*` peer (pi's own rule for host-provided packages); the window is
  `PI_HOST_SUPPORTED_RANGE` in `install-smoke.yml`, the "Verified hosts" list in
  `docs/release-qa-baseline.md`, and the release-QA host ratchet in
  `tests/packaging.test.ts`, which now fails when any two of the three disagree.
  On an older pi, stay on the previous pi-lens release or upgrade pi.
