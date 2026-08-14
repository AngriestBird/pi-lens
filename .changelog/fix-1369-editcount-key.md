---
section: Fixed
---

- **Edit counts now match normalized file paths (closes #1369)** — `AgentBehaviorClient.getEditCount` now uses the same path normalization as edit recording, so mixed-separator and case-variant lookups return the recorded count.
