---
section: Fixed
audience: internal
---

- **Markdown table cells escape the backslash before the pipe (#4490)** — `escapeMarkdownCell` in `scripts/lib/markdown-cell.mjs` escapes the backslash, then the pipe, in the census issue body, the per-test candidate table and the mutation-table row written by `scripts/mutate.mjs`. A test title or error holding `a\|b` no longer splits its row. The rule-catalog generator now imports the helper with its output unchanged. The mutation report keeps its code-span escaping. The identifier-only `$` escapes in `tests/clients/finding-delivery-gate.test.ts` use the shared `escapeRegExp`. Pinned by `tests/scripts/markdown-cell.test.ts`, the census and stryker row cases, and the mutate title case.
