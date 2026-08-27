---
section: Fixed
---

- **Anchor `.gitignore`'s scratch `test-*` patterns to the repo root (refs #2250)** — the unanchored `test-*.ts`/`.js`/`.py`/`.md`/`.sh`/`.mjs` rules matched the basename of any tracked file at any depth, silently hiding `clients/test-runner-client.ts` and several `tests/` files from `rg` and other ignore-respecting search tools. `git status` never flagged it because git still tracks the files. The patterns now only match scratch files dropped at the repo root, their original intent.
