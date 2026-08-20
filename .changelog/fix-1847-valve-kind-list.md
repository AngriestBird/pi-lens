---
section: Fixed
---

- **`require-safety-comment-for-as-unknown-as`'s `SAFETY:` valve now accepts a comment above an exported or class-field cast (closes #1847)** — the rule's `inside:` kind list was missing `export_statement` and `public_field_definition`, so a documented `export const` or class-field cast had no way to satisfy the ERROR-tier blocking rule.
