---
section: Changed
audience: internal
---

- Document line addressing has one owner. `clients/lsp/content-scan.ts` walks a document once for the LF count and the last LSP-addressable line, and the LSP sync bound (`exceedsLspSyncLimits`) plus `lineTextAt` now read that walk instead of running `content.split("\n")` themselves — one substring per line, ~40 800 of them on a 1.95 MB document. On a 1.95 MB document the bound check drops from 1.56 ms to 0.94 ms and `lineTextAt` from 0.65 ms to under 0.01 ms for a line near the top (#2066). The #1095 content hash still makes its own native sha256 pass; folding it onto the walk measured 1.8x slower (3.10 ms against 1.69 ms), so it stays native and separate.
