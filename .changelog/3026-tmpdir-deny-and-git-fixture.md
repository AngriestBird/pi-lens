---
section: Changed
---

- **Deny `TMPDIR=.probe-home` in the Bash guard hook and forbid raw commit-ish Git spawns under `tests/` (refs #3026, #3050)** — `scripts/hooks/guard-bash.mjs` gains a fifth deny rule (`tmpdirCollision`) that rejects a `TMPDIR`/`TMP`/`TEMP` assignment aimed at the vitest harness's own `PI_LENS_HOME`, the mistake that produced a false "16 suites red on origin/master" report; `tests/config/git-fixture-governance.test.ts` gains a row that fails any `tests/` Git spawn naming a commit from this repository's history, which CI's depth-1 checkout cannot reach.
