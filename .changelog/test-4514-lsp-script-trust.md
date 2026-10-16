---
section: Fixed
audience: internal
---

- **Nightly LSP scripts adopt project trust and report how much they evaluated (refs #4514)** — `characterize-lsp`, `probe-clean-signal`, `server-capabilities`, `measure-lsp-idle-eviction` and `bench-lsp` now adopt trust through `adoptFixtureProjectTrust`, so the launch gate stops refusing their servers (30 of 54 rows had read `unknown` since 2026-10-10); a census over `scripts/*.mjs` fails a script that reaches `dist/clients/lsp/` without it. A refused row reads `refused: <reason>`. A dedicated `assert-evaluated` step fails the nightly when a producer evaluates less than its measured floor, the handshake layer carries `--min-pass=40`, and the refresh PR does not open when a regenerated doc's count drops more than 20% against HEAD.
