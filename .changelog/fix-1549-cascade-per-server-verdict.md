---
type: fix
---

Keep workspace-sweep diagnostics from answering language servers when an
auxiliary scanner misses its deadline. The result now names only the uncovered
scanner lanes and avoids caching or reconciling the partially covered snapshot.
