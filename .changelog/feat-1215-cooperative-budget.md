---
section: Changed
---

- **Time-budget bulk word-index work (closes #1215)** — Large indexing and refresh workloads now yield cooperatively from a shared monotonic time budget, keeping supersession checks responsive as document cost grows.
