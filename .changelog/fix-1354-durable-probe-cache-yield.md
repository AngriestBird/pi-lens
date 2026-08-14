---
section: Changed
---

- **Re-home probe-cache ageing and cooperative yields (closes #1354)** — authoritative probe-cache commits now prune expired entries while preserving durable-store quarantine recovery; the remaining corpus-scaled scan yields use the cooperative time budget.
