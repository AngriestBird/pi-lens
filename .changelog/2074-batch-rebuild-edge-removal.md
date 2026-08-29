---
section: Changed
---

- **Bound a multi-file review-graph rebuild's edge removal (refs #2074)** — `removeFileOwnedGraphData` now finds a changed file's owned edges through `edgesByFrom`/`edgesByTo` instead of scanning `graph.edges`, and a batch of changed files compacts the edge array once instead of once per file. A multi-file rebuild previously scanned the whole edge array `changedFiles` times; it now scans it once.
