---
section: Changed
audience: user
---

- **Review-graph builds read each function body once (#1740)**. Function facts walked every function body seven times, once per summary field. One pass now computes all of them, with identical summaries. On a 719-file repository a full graph build dropped from 6.32 s to 5.49 s (median, fresh process), and a warm full rebuild from 5.25 s to 4.23 s.
