---
section: Changed
audience: internal
---

- Tier 2 (`tests/support/pi-session.ts`) gains an opt-in inline-factory mode, and six test files leave the pi double for it: the three lazy-liveness files, `bootstrap-lazy-liveness`, `index-cascade-resolved-clean-wiring` and `index-observed-sweep-no-read-guard`. The `--no-delta` case of `index-4483` moves to a tier-2 file with pi's real flag (refs #4937).
