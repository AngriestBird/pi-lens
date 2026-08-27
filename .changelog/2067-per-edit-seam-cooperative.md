---
section: Changed
---

- **Cut the word-index per-edit seam's longest synchronous stretch (refs #2067)** — the cascade and MCP-analyze seams now replace a document through the cooperative primitive, serialized through the index's own operation queue, instead of holding the event loop for the whole replacement. On a 2,829-document, 2.38M-posting corpus the longest synchronous stretch on a large document drops about 3x. Cooperative removal staging now filters each token's postings with the same packed primitive the synchronous path uses, dropping a clock read per posting element. Search results and BM25 scores are unchanged.
