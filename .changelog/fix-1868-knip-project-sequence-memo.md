---
section: Fixed
---

- **Reuse knip results for unchanged project content** — Turn-end and startup
  scans now reuse the last successful knip result when the runtime project
  sequence has not changed. Telemetry distinguishes cached results from
  executed scans, and a new session re-arms execution.
