---
section: Added
---

- **The nightly measures idle-eviction cost and safety for every LSP server (refs #3645)** — `node scripts/measure-lsp-idle-eviction.mjs` spawns each registry server on its smoke fixture, lets the real idle timer release it, respawns it, and regenerates `docs/lsp-idle-eviction.md` with init, memory, respawn result, cold-start and finding-coverage per server, marking an absent toolchain `unavailable` and flagging a server declared `transparent` that the measurement vetoes. It changes no server's eviction policy.
