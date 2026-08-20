---
section: Added
---

- **Husky-managed local git hooks (closes #1804)** — `npm install` now wires
  a pre-commit hook (changelog fragment validation + `npm run lint`) and a
  pre-push hook (build + targeted `vitest` for changed files, never the full
  suite). Both are skippable with `PI_LENS_SKIP_HOOKS=1`, which agents and CI
  set; humans leave hooks on. Hook install itself is skipped for CI and
  production/consumer installs, and never fails `npm install` on error.
