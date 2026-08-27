---
section: Added
---

- **Enable Kotlin structural linting (refs #2198)** — Add eight VTCode-derived Kotlin ast-grep rules (`kotlin-no-lateinit`, `kotlin-no-nullable-boolean`, `kotlin-no-println`, `kotlin-no-unnecessary-let`, `kotlin-no-unsafe-cast`, `kotlin-no-var`, `kotlin-prefer-data-class`, `kotlin-prefer-is-empty`). Kotlin delivers through the ast-grep CLI/LSP lane, because `@ast-grep/napi` 0.45.1 ships no Kotlin grammar.
