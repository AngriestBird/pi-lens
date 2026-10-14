---
section: Changed
audience: internal
---

- **The registry-package install-smoke legs run in a project that carries its own `typescript` (#4401)** — `pi-load` and `mise-repro` run the published pi-lens, which cannot start the TypeScript server when the only compiler is a bare `tsc` on PATH (#4414, fixed on master, unreleased). The RPC smoke now waits for the TypeScript server to start or fail, instead of a fixed second after the turn, and fails when it did not start.
