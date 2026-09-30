---
section: Added
---

- `formal/coverage-map.json` maps runtime source globs to TLA+ model families,
  and `scripts/lib/tla-coverage.mjs` (wired into the PR-body lint) fails a PR
  that changes a mapped file without moving that family's model or declaring
  `TLA+ unaffected: <family> — <reason>`; `unmodelled` seams stay advisory
  (closes #3802).
