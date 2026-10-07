---
section: Fixed
audience: internal
---

- **Windows absolute-path branch now exercised on every lane (closes #1506)** — `isFullyQualified`'s win32 arm is driven under a stubbed platform on the Linux lane and by a gated native cell the Windows Vitest subset selects, so a POSIX-literal fixture can no longer pass by construction.
