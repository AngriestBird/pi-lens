---
section: Added
---

- **Prefix filters for word-index queries: lang, file, ext (Closes #1450)** — `symbol_search`/`pilens_symbol_search` queries can now mix plain terms with composable `lang:`, `file:`, and `ext:` prefix filters, plus `-` negation, e.g. `lang:jsts file:clients/ -file:test rank`. A hand-rolled tokenizer (`parseWordIndexQuery` in `clients/word-index.ts`) splits filters from terms; `lang:` resolves through `KIND_EXTENSIONS` (`clients/file-kinds.ts`), the single source of truth, so there is no second, hand-maintained language list. Filters apply as a pre-ranking predicate, composing with the existing `paths`/`lang` structured options, before BM25/priors/centrality scoring runs. An unrecognized prefix or `lang:` kind throws a typed `WordIndexQueryError` naming the supported list instead of silently degrading to a literal search term.
