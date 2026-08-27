---
section: Fixed
---

- **Give nested ignore rules and path verdicts one freshness clock (closes #2071, closes #1976)** — a nested `.gitignore` edit no longer leaves two paths under the same rule disagreeing, and the ignore matcher stats a nested source once per cadence window instead of once per file. A 2000-file walk drops from 18,064 `statSync` calls (9.03 per file) to 192 (0.10 per file), and from 1,886 ms to 96 ms.
