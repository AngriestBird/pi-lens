---
section: Changed
---

- **Review-graph one-file rebuild (refs #2074)** — the incremental rebuild now reads the graph's own adjacency indexes instead of rescanning every edge. Restoring preserved incoming edges and reading a changed file's import targets both became bucket lookups, and the derived indexes stay live through the update instead of being rebuilt at the end. On a 1,600-file fixture a one-file rebuild drops from 48.0 ms to 33.6 ms median, with edge-metadata comparisons down from 9,600 to 4 and edge visits down from 19,200 to 8. The same fix makes `existedBefore` report the truth, which unblocks reverse-dependency index reuse on every incremental build.
