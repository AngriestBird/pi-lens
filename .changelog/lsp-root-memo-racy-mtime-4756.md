---
section: Fixed
audience: user
---

- **LSP root follows a marker added or removed right after a lookup (#4756)** — the per-directory root memo trusted an unchanged directory mtime, but a directory last changed a few milliseconds before the lookup takes its next change in the same file-system timestamp tick (10-16 ms on Windows), so a deleted `Package.swift` stayed the root and a new nearer `.git` did not move it. A lookup whose directories were stamped that close to it is no longer memoized.
