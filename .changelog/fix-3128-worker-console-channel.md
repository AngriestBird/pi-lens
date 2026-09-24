---
section: Fixed
---

- **Worker-side test diagnostics now reach passing-run logs (closes #3128)** — replaced the scoped warning/error paths with newline-terminated `process.stderr.write` records, including the tests-tree guard's two sites, so Vitest's default worker reporter cannot silently drop them.
