---
section: Changed
audience: internal
---

- `scripts/check-pr-body.mjs` now refuses a body that names a record literal under `## Observability` unless a test under `tests/` reads it back, over blanked test source so a comment does not count (#4597). The rule is the mechanical half of `docs/pi-lens-fixer.md`'s record rule; `none: <reason>` stays valid, and a probe that cannot run refuses instead of passing.
