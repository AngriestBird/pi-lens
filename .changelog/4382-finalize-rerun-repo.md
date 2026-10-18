---
section: Fixed
audience: internal
---

- The `Finalize CI rerun classification` job now gives `gh` a repository source (`GH_REPO`) instead of relying on a checkout it does not have, so the terminal `ci:real` / `ci:infra` label swap runs. Every job that reached that write had failed with `failed to run git: fatal: not a git repository` since 2026-10-10, and a new census in `tests/config/github-token-write-gates.test.ts` reds a workflow job that calls `gh` with no `GH_REPO`, checkout, or `-R` (refs #4382). The census now shares command-position parsing with the Bash guard and checks repository operands against each invocation’s effective environment.
