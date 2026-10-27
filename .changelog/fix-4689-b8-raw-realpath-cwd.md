---
section: Changed
audience: internal
---

- **Raw realpath calls feeding a config root, a write target and the data-dir probe move onto the identity seam (refs #4689)** — `clients/sgconfig.ts` and `clients/partial-edit-apply.ts` resolve through `realpathOrResolve`, and `dataDirCanonicalRoot` answers `fallback` with an existence check instead of a discarded `realpathSync`; the foreign-checkout lookup in `clients/test-runner-client.ts` keeps its raw realpaths and the sweep pin now says why.
