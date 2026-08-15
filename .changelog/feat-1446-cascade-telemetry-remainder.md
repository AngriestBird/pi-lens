---
section: Added
---

- **Cascade injection, test-targeting, and cache-effectiveness telemetry (Closes #1446)** — `cascade_injected` (what text and how many neighbors/diagnostics actually reached the agent, answering item 1) and `cascade_test_targets` (which tests were suggested for cascade neighbors, including the zero-suggestion case, answering item 2) are new `cascade.log` records. `cascade_result` now also carries `cacheHits`/`recentlyCleanHits`/`coldTouches` (item 5's cache-effectiveness measurement, unblocked now that #1444 has landed) and `neighborBudget`/`budgetTruncated` (item 4's telemetry half). Item 3 (`lsp_diagnostics_timeout` server attribution) was already delivered by #1457. Item 4's budget-vs-settle-time sizing change is re-homed as #1462.
