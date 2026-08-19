---
section: Fixed
---

- **TypeScript diagnostics on files outside every tsconfig no longer block** — a file that matches no project's `include` is still checked by tsserver, but in a synthetic *inferred* project with default compiler options the project's own `tsc --noEmit` never uses. Those diagnostics now render as warnings labelled `not in any tsconfig project — checked with inferred settings; add <dir>/** to a tsconfig for authoritative checking` instead of unlabelled 🔴 blockers. They are demoted, never suppressed: the live report that prompted this found the batch was a mix of phantom errors and genuine ones the project's own gate cannot see. Detection asks tsserver directly (`projectInfo` → `configFileName`); when the probe cannot answer, nothing is demoted.
