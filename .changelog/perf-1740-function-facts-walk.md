---
section: Changed
audience: user
---

- **Review-graph builds read each function body once (#1740)**. Function facts walked every function body seven times, once per summary field. One pass now computes all of them, with identical summaries. On a 719-file repository a full graph build dropped from 6.76 s to 5.65 s (median, fresh process), and a warm full rebuild from 5.39 s to 4.37 s.
