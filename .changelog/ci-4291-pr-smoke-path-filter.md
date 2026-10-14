---
section: Changed
audience: internal
---

- **A pull request that touches RPC, install, LSP launch or trust paths runs the deep install smoke (#4291)** — `install-smoke.yml` runs all four pi-load cells (npm-global, pnpm-global, bun-global, curl) on ubuntu and an advisory LSP handshake job on such a PR. Other PRs that reach the workflow keep the one pnpm-global cell. One path list (`PR_SMOKE_PATHS` in `scripts/ci-changed-files.mjs`) drives both, pinned by `tests/config/pr-smoke-paths.test.ts`.
