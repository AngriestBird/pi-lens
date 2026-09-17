---
section: Fixed
---

- **The tests-tree write guard no longer crashes the Unit tests job on a scratch-directory race (refs #3179)** — `tests/support/tests-tree-write-guard-setup.ts` armed a recursive `fs.watch` over `tests/` with no `'error'` listener. On Linux, node's recursive watch is a JS polyfill that re-scans a changed subfolder with a synchronous `readdirSync`; when `tests/index-2992-integration.test.ts` removed its own exempt scratch directory (`tests/support/.index-2992-scratch`) between the change event and that rescan, the polyfill emitted an unhandled `'error'` event and killed the whole vitest process with exit 1 and no failing test. The guard now attaches an `'error'` handler that swallows ENOENT for paths under its existing exempt prefixes and records any other error once via `console.warn`, never per event.
