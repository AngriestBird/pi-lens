---
section: Fixed
audience: user
---

- **A bash result that joins a running look still gets its declaration walk (refs #4532)** — when a tool call's look was in flight, a bash result that joined it got only the tool call's throttled look, so a `.d.ts` its command generated reached no language server until a later walk. The joined bash result's walk demand now rides the flight, in both the out-of-band look and the HEAD look, and the `lsp_out_of_band_change` row says `joinedWalk: true` when the walk was a joiner's.
