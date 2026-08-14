---
section: Fixed
---

- **In-pi extension logging no longer corrupts the pi TUI layout (closes #1333)** — pi owns the terminal, so the 26 ungated and 20 verbose-gated `console.error`/`console.warn` sites under `clients/` were landing raw bytes mid-frame and desyncing pi's screen model. Every site now writes to a `createNdjsonLogger` sink (the subsystem's own `tree-sitter.log`/`review-graph.log`/`latency.log` where one exists, otherwise the new `~/.pi-lens/extension.log`), user-facing degradations (invalid config, offline grammar fetch, WASM abort) additionally surface through `ctx.ui.notify`, and `index.ts` installs a defensive console reroute so a transitively loaded dependency cannot write to the frame either.
