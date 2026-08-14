---
section: Fixed
---

- **Review-graph size gates stop at the cap sentinel (closes #1372)** — the shared cooperative source walk now stops at `maxFileCount + 1`, reports the partial count honestly as “more than N files,” and emits a distinct near-miss telemetry event within 5% of the cap.
