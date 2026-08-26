---
section: Fixed
---

- **Make LSP spawn records count truthfully (closes #2064)** — `lsp_client_selected` reported `cold-spawn` for every caller that merely joined another caller's in-flight spawn, so the one metric that looked like a spawn count over-counted 3.0x in a 21.8 h field window, and one 29.3 s TypeScript spawn read as 39 spawns in 2 ms. The record now names the starter (`cold-spawn`, `spawn-failure`) apart from the joiners (`cold-spawn-joined`, `spawn-failure-joined`), on the same record with the same denominator. A new `lsp_server_spawned` latency record fires once per language-server process start for every server, so `latency.log` finally counts TypeScript spawns, which `lsp_launch_candidate_success` never covered.
