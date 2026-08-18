---
section: Fixed
---

- **`createVenvFinder` now checks the managed tools dir before falling back to PATH (closes #1638)** — the resolver behind `createAvailabilityChecker` (golangci-lint, ruff, shellcheck, pyright, shfmt, spotbugs, terragrunt, tflint, trivy, helm, jscpd, knip, ktfmt, madge, and others) checked venv paths, then fell straight to a bare-name PATH probe. A tool installed only into `~/.pi-lens/tools/node_modules/.bin/<tool>` (where `ensureTool` puts npm-strategy installs) never resolved there, so every dispatch re-probed PATH, missed, spawned a doomed `--version` process, and only then fell through to the installer's own cache a few lines later — one wasted spawn per dispatch, for the life of the session, on top of the availability noise that made #1615's compensating row re-fire on every call. `createVenvFinder` now checks `findManagedNodeToolBinary` — the same managed-dir lookup already used elsewhere in this file — between the venv paths and the bare PATH fallback.
  - `clients/dispatch/runners/utils/runner-helpers.ts` — `createVenvFinder`.
