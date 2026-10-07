---
section: Fixed
audience: internal
---

- **LSP fixture tests name their `dist/` precondition (closes #4003)** — `lsp-fixture-workspace` and `smoke-tools-lsp-fixture-registration` now fail with "run `npm run build:dist` first" instead of an oblique `Cannot find module dist/...`, so they no longer depend on a sibling file having built `dist/`.
