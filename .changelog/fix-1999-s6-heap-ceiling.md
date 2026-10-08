---
section: Changed
audience: user
---

- **Document a V8 heap ceiling for long pi sessions (refs #1999)** — Recommend starting pi with `NODE_OPTIONS=--max-old-space-size=700` when long pi-lens sessions approach host memory limits, and explain how to observe the relevant memory samples.
