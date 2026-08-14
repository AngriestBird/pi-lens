---
section: Fixed
---

- **Bound warm word-index memory (closes #1370, refs #1332)** — idle/LRU per-root eviction now releases inactive indexes safely, while persisted snapshot postings no longer remain duplicated in long-lived in-memory caches.
