---
section: Fixed
---

- **Detect different-size project-snapshot rewrites inside one mtime bucket (closes #2285)** — The authoritative in-process cache now validates both body mtime and size before serving its snapshot, so a hot project root cannot mask a different-length external write indefinitely. Same-size, same-mtime rewrites remain outside this metadata-only hot-path guarantee.
