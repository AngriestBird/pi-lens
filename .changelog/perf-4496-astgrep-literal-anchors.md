---
section: Changed
audience: user
---

- **Project scans skip ast-grep rules that cannot match a file (#4496)**. A rule whose required literal text is absent from the file no longer pays a native match call. A 300-file scan of this repository went from 16.3 s to 10.5 s warm, with identical diagnostics. The per-edit ast-grep runner uses the same check.
