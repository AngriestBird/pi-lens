---
section: Fixed
---

- **Formatter config-signature walk no longer scales with the candidate list (closes #1603)** — `findUp` (used by `formatterConfigSignature` and every `has*Config` check) now reads each ancestor directory once and checks membership in-memory, instead of issuing one `fs.access` per candidate filename per directory. The walk still runs on every `getFormattersForFile` call, so a formatter config created or edited after the first call for a cwd still invalidates the cache exactly as before (#1572/#1596); its cost just no longer grows with how many names `FORMATTER_CONFIG_FILES` holds.
