---
section: Added
audience: user
---

- **Opt-in fallow-lsp: unused-export and dead-code findings for JS/TS files (refs #4929)** — set `fallow.enabled: true` in `~/.pi-lens/config.json` (or pass `--lens-fallow`) and pi-lens downloads the pinned fallow-lsp 3.37.0 release, checks its sha256, and runs it beside the TypeScript server on `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` files only. Findings arrive as advisory warnings tagged `fallow:<rule>` and never block. It is off by default; any value other than a literal `true` leaves it off, nothing is downloaded or launched while it is off, and the install and launch follow the same project-trust gate as the other language servers. knip, jscpd and madge are unchanged.
