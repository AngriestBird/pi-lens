---
section: Changed
---

- **Docs: agent-guide reflects the stale-secrets ACTION NEEDED tier (refs #1522)** — `docs/agent-guide.md`'s honesty-contract table and blockers-vs-advisories section now describe the `🔑 ACTION NEEDED` tier #1627 added: a secrets finding whose cached file changed since the scan demotes to this tier, with its line number withheld, instead of dropping silently or reading as a plain advisory. CUE's LSP/formatter/tree-sitter documentation (`docs/features.md`, `docs/language-coverage.md`) was already brought current by #1520; this fragment covers the sweep verifying those pages and the wider today's-merges gap check, which found the rest of the surfaces (README.md, `docs/servercapabilities.md`'s generation note) already accurate.
