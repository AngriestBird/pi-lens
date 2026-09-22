---
section: Fixed
---

- **Block string-text laundering in detector sweeps (refs #3257)** — escape-regexp, availability-classifiedBy, and latency-logger scans now distinguish code from string and template-literal text while retaining literal evidence.
