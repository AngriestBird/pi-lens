---
section: Added
---

- **Husky-managed local git hooks (closes #1804)** — `npm install` now wires
  a pre-commit hook (changelog fragment validation + `npm run lint`) and a
  pre-push hook (build + a capped, full-path-resolved targeted `vitest`
  selection for changed files, never the full suite; degrades to build-only
  past 25 matched test files or a 2-minute shared test-lock wait). Both are
  skippable with `PI_LENS_SKIP_HOOKS` set to any non-empty value, which
  agents and CI should set; humans leave hooks on. Hook install itself is
  skipped for CI and production/consumer installs, and never fails
  `npm install` on error.
