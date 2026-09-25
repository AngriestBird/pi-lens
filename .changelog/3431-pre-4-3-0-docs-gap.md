---
section: Changed
---

- **Close the pre-4.3.0 docs gap audit (closes #3431)** — document the LSP
  sync content bound (2 MiB / 5000 lines) and the new `textDocument/didSave`
  behaviour in `docs/agent-tools.md`; add the missing `pilens_session_end`
  row and the review-graph/config-core nodes to the README architecture
  diagram; correct the "a dozen-plus language servers" figure to 46; index
  ADR 0008; document the `PILENS_PROBE`/`PILENS_UNSAFE_FORCE_GRAMMAR_LOAD`/
  `PILENS_PUB_DEBUG` diagnostic env vars and widen the recovery grep; bring
  the pre-commit hook description and the contributor path (guard-bash.mjs,
  `PI_LENS_TEST_MAX_WORKERS`, the mutation lane, release-QA) up to date; and
  rename the retired `lsp_diagnostics` tool name to `lens_diagnostics` in two
  earlier changelog fragments.
