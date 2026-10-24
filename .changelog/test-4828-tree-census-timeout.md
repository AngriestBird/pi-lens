---
section: Fixed
audience: internal
---

- **Tree-walking governance censuses carry a timeout budget (#4828).** Tests in `tests/config` that walk the repo tree had vitest's 5 s default and reded on the Windows unit leg; they now pass the shared `TREE_WALK_TIMEOUT_MS` (30 s, scaled by the lane), and `tests/config/tree-census-timeout.test.ts` refuses a new census without it.
