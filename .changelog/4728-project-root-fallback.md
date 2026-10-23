---
section: Fixed
audience: user
---

- **Share fallback LSP roots across project directories.** When language-specific markers are absent, use the nearest generic project marker instead of starting a separate workspace for each directory; keep loose-file and extensions-boundary behavior (closes #4728).
