---
section: Fixed
audience: internal
---

- **Tests no longer build `dist/` in the checkout, and the LSP fixture tests name their `dist/` precondition (closes #4003)** — `packaging-pack-manifest` now runs its real `npm pack` in an isolated copy, a repo-root census guard in `tmp-fixture-hygiene` reds on a new `dist/` or `.pack-backup/`, and `lsp-fixture-workspace` and `smoke-tools-lsp-fixture-registration` fail with "run `npm run build:dist` first" instead of an oblique `Cannot find module`.
