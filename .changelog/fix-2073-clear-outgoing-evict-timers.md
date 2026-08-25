---
section: Fixed
---

- **Clear outgoing idle-eviction timers on cache replacement (refs #2073)** — Review-graph, reverse-dependency, and authoritative project-snapshot cache replacements now release the prior entry's timer before installing the new entry, preventing one full payload from being retained per rebuild. Regression coverage asserts one live timer after twenty replacements for each cache family.
