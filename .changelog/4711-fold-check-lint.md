---
section: Changed
audience: internal
---

- **`scripts/check-pr-body.mjs` now reads the `## Fold check` section AGENTS.md requires (#4711).** A PR opened with a raw `gh pr create` skipped the fold-check rule because the CI body lint never looked for the section, while the maintainer's local gate refused the same body; two fixer bodies on 2026-10-21 were refused only locally. The lint refuses a body with no section, and a section holding neither a decision line (`#N`, one of `folded` / `not folded` / `sequenced`, then the reason) nor `none: <reason>`. The section's verdict parser is the one `## Class sweep` uses, so one body satisfies both gates; the candidate list stays the local script's to compute. The template, the flattened-body repair's heading list, and the fixer, reviewer, and merge-policy docs carry the section.
