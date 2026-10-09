---
section: Fixed
audience: user
---

- **Ast-grep fallbacks select the official CLI package (#4193)** — Structural rule replacements and CLI probes use `@ast-grep/cli` explicitly when direct binary resolution fails, preserving cache-only execution.
