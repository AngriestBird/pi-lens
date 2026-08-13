---
section: Security
---

- **Honor the pi host's project-trust decision before installing or spawning anything (refs #1334)** — pi-lens now reads `ctx.isProjectTrusted()` at every `session_start`. When the host says a project is NOT trusted, tool auto-install degrades to discovery-only (nothing is downloaded or executed) and LSP servers are not spawned; in-process analysis, caches and tree-sitter continue unchanged. Hosts that expose no trust surface behave exactly as before.
