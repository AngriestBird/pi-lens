---
section: Fixed
audience: user
---

- **Upward walks start from the file's real path.** A file reached through a file link now reads its target's Cargo edition, package root, `node_modules` and metrics-history commit, not the link's neighbours; every hand-rolled climb in `clients/` now runs on `walkUpDirs`, and a test runs each walker from a symlink twin (refs #4966).
