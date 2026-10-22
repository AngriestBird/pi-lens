---
section: Changed
audience: user
---

- **A document sync no longer measures bytes the edit path just measured.** The `didOpen`/`didChange` send reused neither the sync bound's newline count (`clients/lsp/content-limits.ts`, run by the post-write pipeline and the dispatch LSP runner on the same string) nor the `#1095` fingerprint the LSP service computes before it notifies (`clients/lsp/index.ts` `touchFile`), so every send walked the document twice more for answers it already had. Both are now handed to the send (`clients/lsp/content-scan.ts` `countLfNewlines` -> `scanDocumentContent`, `recordSentContent`'s `contentHash`): one full LF walk and one full sha256 removed per edit, 0.0716 -> 0.0575 ms of per-edit document work over 200 real files (x0.80), and x0.77/x0.84 on a 100 KB / 1.96 MB document. The digest is unchanged for the same bytes, and the send still walks and hashes for itself whenever no measurement of those exact bytes is on hand (`#2066`).
