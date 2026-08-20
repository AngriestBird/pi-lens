---
section: Fixed
---

- **Surface silent LSP scanners to the agent (refs #1867)** — Per-edit
  diagnostics now render a compact coverage marker when one or more auxiliary
  scanners did not answer. An empty partial result is labeled incomplete instead
  of looking like a clean pass, and repeated notices retain the existing
  per-file session dedupe.
