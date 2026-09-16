---
section: Fixed
---

- **A file created under a spelling the filesystem re-cases keeps its write record (refs #3163)** — the read guard announced a pending creation while the file was still absent and looked the announcement up after it landed, both times through `normalizeFilePath`, whose answer depends on that very existence. Any spelling whose key moved as the file appeared (on Windows every new file with an upper-case letter in its name; on POSIX a parent directory reached through a case-variant symlink) orphaned the announcement, so the synthetic creation read was never injected and the just-written file lost the outstanding-read protection that keeps it editable across an idle session. The announcement is now keyed by the existence-independent syntactic spelling the guard already uses for its post-delete index.
