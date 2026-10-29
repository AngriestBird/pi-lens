---
section: Added
audience: internal
---

- `node scripts/probe-save-verdict.mjs` measures, per server, whether a language server publishes its findings without a `textDocument/didSave` or only after one, through the real client on the tool-smoke fixtures. The nightly `tool-smoke` workflow runs it with `--install` and it regenerates the three measurement columns of `docs/lsp-capability-matrix.md`'s save-verdict table, merge-guarded so a runner that cannot install a server keeps that row, and a fixture whose declared toolchain never installed names the installer's own cause on the run's line instead of reading `server never spawned`. `tests/config/lsp-save-verdict-census.test.ts` pins the population, the verdict vocabulary and the rule that a verdict without provenance is refused. (refs #3405)
