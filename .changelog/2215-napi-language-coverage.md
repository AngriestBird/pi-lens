---
section: Fixed
---

- **Run the ast-grep in-process fallback on every JS/TS module extension, and record the languages it cannot serve (closes #2215)** — `.mjs`, `.cjs`, `.mts`, and `.cts` files reached the napi fallback and were dropped without running a single rule, because its extension allowlist was hand-maintained beside three other lists that described the same thing. All four now derive from one language matrix, so the ~470-rule catalog reaches those files. The twelve catalog languages `@ast-grep/napi` bundles no grammar for (python, java, go, ruby, cpp, rust, csharp, c, kotlin, swift, php, scala — 247 of the 470 rules) are recorded as ast-grep LSP/CLI-only rather than silently skipped, the skip telemetry now names each language's delivery route, and a file admitted for a grammar the loaded addon turns out not to have leaves an `ast-grep-napi-language-unavailable` degradation record instead of nothing.
