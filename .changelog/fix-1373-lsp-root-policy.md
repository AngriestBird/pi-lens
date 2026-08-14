---
section: Fixed
---

- **Keep LSP roots inside the session project and coalesce nested marker clients (closes #1373, refs #1328)** — Clamp marker-selected roots at the declared cwd, and reuse same-server ancestor clients for config-only nested roots while preserving real manifest/lockfile sub-projects.
