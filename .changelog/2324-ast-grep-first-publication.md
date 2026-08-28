---
section: Fixed
---

- **ast-grep findings survive a silent auxiliary LSP (refs #2324)** — the napi fallback stays active until the ast-grep LSP completes its first diagnostic publication for the root, closing the startup window where Gate B skipped the runner and a never-publishing server silently lost the findings.
