---
section: Added
---

- **Opt Typst (tinymist) into the nightly LSP clean-gate (refs #3037, #3164)** — `tests/fixtures/tool-smoke/typst/main.typ` now carries a deliberate `#undefined_function(answer)` call and the `typst` `LSP_FIXTURES` entry in `scripts/smoke-tools.mjs` sets `lspGate: true` with `lspGateMarker: "#undefined_function"`, following the typescript entry's shape; `--lsp-gate typst` now proves tinymist surfaces a real primary diagnostic instead of only handshaking, and `tests/scripts/smoke-tools-lsp-gate-fixtures.test.ts` was updated for the seven-fixture gated population.
