---
section: Added
audience: internal
---

- Add `npm run lane:check` as the delegated-worker pre-handback gate: one clean / red-caused / unproven verdict (exit 0 / 1 / 3), a change set that includes uncommitted work, and a `git archive` base tree in `scripts/red-on-base.mjs` for lanes that refuse `git worktree add`.
