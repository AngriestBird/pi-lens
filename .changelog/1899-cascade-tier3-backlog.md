---
section: Fixed
---

- **Bound the cascade tier-3 reconcile backlog and drop the dead neighbour-touch cache ([closes #1899](https://github.com/apmantza/pi-lens/issues/1899))** —
  the outstanding-touch registry now caps its entry count and its entry age
  instead of growing until a quiet window arrives, every sweep writes a backlog
  gauge to `cascade.log`, and an unresolved touch says which of the five causes
  kept it unresolved. The same-write neighbour-touch cache is removed: its read
  gate could only pass inside a single write, so it measured 0 hits across 236
  cold touches.
