---
section: Fixed
---

- **Count every LSP client, and stop leaking a subagent's temp root (refs #2130)** — `memory_sample.subsystems.lsp.clients` now counts clients across every module evaluation, so a host serving a secondary root no longer reports `clients: 1` beside `lspChildCount: 2`. `deregisterInstanceRoot` shares the registry mutation tail, so a short-lived subagent can no longer remove its root before its own queued add lands and leave the temp root in `instances.json` for the rest of the host's life. A host entry synthesized from an `lsp-fallback` guess now yields its primary slot to the session's real root instead of pinning the guess forever.
