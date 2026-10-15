---
section: Fixed
audience: internal
---

- **One Markdown table-cell escaper escapes the backslash before the pipe (#4490)** — `escapeMarkdownCell` in `scripts/lib/markdown-cell.mjs` replaces the four inline pipe-only or pipe-after-backslash copies (the census issue body, the mutation report, the per-test candidates and the rule catalogs). A test title or error holding `a\|b` no longer splits its row. The two identifier-only `$` escapes in `tests/clients/finding-delivery-gate.test.ts` use the shared `escapeRegExp`. Pinned by `tests/scripts/markdown-cell.test.ts`.
