---
section: Fixed
audience: user
---

- **A new file now refuses only the cached diagnostics that depend on it (refs #4346)** — Before, any file created under a language server's root made `lsp_diagnostics` and `lens_diagnostics mode=full` re-check every cached file with findings from that server, and never a cached clean file. Now a cached answer is refused when the new file is in its dependency scope: a file its imports resolve to or name, a TypeScript or JavaScript ambient file (a `.d.ts`, `declare global`, `declare module`, or a script) for a JS/TS file, or a file of the same package for a Go file. That includes clean answers, so a new global or package file that breaks a clean file is checked again. Other cached answers keep serving. A cached Go answer is also refused when a file of its package is edited or removed. Before a check answers, pi-lens now announces a Go file's new package files to its servers, as it already did for import targets. Languages whose implicit scope is not modelled (Python, Java and others) keep the old rule for answers with findings.
