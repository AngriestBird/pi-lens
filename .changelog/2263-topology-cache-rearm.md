---
section: Fixed
---
- **Topology-derived startup scan and language-profile memos now re-arm with the workspace marker index at session start (closes #2263)** — `resetWorkspaceTopology()` now walks one registered downstream-cache reset list, clearing `startupScanContextCache` and `languageProfileCache` with the source index. A new session therefore re-derives project-root and configured-language answers after marker changes; mid-session edits remain governed by each consumer's existing freshness policy.
