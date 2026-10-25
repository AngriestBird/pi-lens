---
section: Fixed
audience: user
---

- **`lens_diagnostics` mode=full no longer shows a stale blocker beside a clean sweep when the file is spelled through a symlink** — the sweep names a file by its real path while the widget store holds the spelling the writer used, so the fresh result did not retire the stored row, did not mark an unreconciled one stale, and rendered one file twice. The merge now keys both sides by the file's path identity.
