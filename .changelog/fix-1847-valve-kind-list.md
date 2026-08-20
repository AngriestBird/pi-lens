---
section: Fixed
---

- **`require-safety-comment-for-as-unknown-as`'s `SAFETY:` valve now accepts a comment above an exported, class-field, or enum-member cast (closes #1847)** — the rule's `inside:` kind list was missing `export_statement`, `public_field_definition`, and `enum_assignment`, so a documented `export const`, class-field, or enum-member cast had no way to satisfy the ERROR-tier blocking rule.
