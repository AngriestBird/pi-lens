---
section: Fixed
---

- **Record message_end cache_usage attribution loss (closes #1956)** — A stale extension ctx now records a bounded `cache-usage-attribution-stale` ledger entry instead of silently writing the `cache_usage` row unattributed; the row still writes so provider token and cost data is never dropped.
