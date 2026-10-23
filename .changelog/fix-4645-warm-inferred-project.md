---
section: Fixed
audience: user
---

- **Keep inferred-project diagnostics non-blocking under warm attach (closes #4645).** The incumbent labels and demotes TypeScript errors for files outside every tsconfig project before returning them to attached clients, through the same demotion pipeline a local session uses, and keeps their quick fixes. An attached session sees the change once the longest-lived process has restarted on this version.
