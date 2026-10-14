---
section: Changed
audience: internal
---

- **The registry-package install-smoke legs run in a project that carries its own `typescript` (#4401)** — `pi-load` and `mise-repro` run the published pi-lens, which cannot start the TypeScript server when the only compiler is a bare `tsc` on PATH (#4414, fixed on master, unreleased); the legs went red on master depending on the runner image. The RPC smoke also prints which `tsc` is on PATH.
