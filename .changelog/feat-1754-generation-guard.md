---
section: Changed
---

- **One generation guard instead of four hand-rolled ones** — Add
  `clients/generation-guard.ts`: a `GenerationSource` counter owned by the
  seam that resets a store, plus a handle whose `guardedWrite` drops a
  post-await write when the world it captured is gone, and records the drop in
  the degradation ledger under `generation-guard-stale-write`. A keyed
  `GenerationMap` covers stores invalidated per cwd or per request. Dispatch
  availability and the LSP workspace-diagnostics cache now guard through it;
  a test sweep requires every remaining hand-rolled generation compare to
  carry a written reason.
