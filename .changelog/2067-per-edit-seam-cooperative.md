---
section: Changed
---

- **Move the word-index per-edit seam off the event loop (refs #2067)** — the cascade and MCP-analyze seams now replace a document through the cooperative primitive, which yields on the 8 ms budget and is serialized through the index's own operation queue, instead of holding the loop for the whole replacement. Cooperative removal staging filters each token's postings with the same packed primitive the synchronous path uses, dropping a clock read per posting element: on a 2,829-document, 2.38M-posting corpus that took a large-document edit from 68.9 ms to 21.8 ms, and the seam's longest synchronous stretch from 76.7 ms to 32.4 ms. Search results and BM25 scores are unchanged.
