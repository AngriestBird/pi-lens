---
section: Fixed
audience: user
---

- **Keep inferred-project diagnostics non-blocking under warm attach (closes #4645).** The incumbent labels and demotes TypeScript errors for files outside every tsconfig project before returning them to attached clients.
