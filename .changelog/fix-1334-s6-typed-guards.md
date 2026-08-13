---
section: Changed
---

- **Enforce the host-SDK type-only import rule that keeps clean installs working (refs #1334)** — `@earendil-works/pi-coding-agent` is an optional peer that pi omits at install time, so a value import of it breaks pi-lens at user sites. That rule was prose only; a regression test now scans every shipped source file for static, dynamic and `require` value imports and fails the build on one. The edit-tool result payload also now uses the host's own `EditToolDetails` type instead of a locally re-declared shape.
