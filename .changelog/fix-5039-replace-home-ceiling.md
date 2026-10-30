---
section: Fixed
audience: user
---

- **`ast_grep_replace` refuses a working directory at or above `$HOME`** — the mutating tool had the ceiling `ast_grep_search` already enforced, so a dry run from your home directory previewed, and an apply rewrote, files anywhere under it. Both tools now decide through one guard in `tools/shared.ts`, and `#5039`'s refusal names the offending cwd and asks for explicit `paths`.
