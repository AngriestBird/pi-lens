---
section: Fixed
---
- **Topology-derived startup scan and language-profile memos re-arm with the workspace marker index at session start (closes #2263)** — `resetWorkspaceTopology()` walks one registered downstream-cache reset list, clearing `startupScanContextCache`, `languageProfileCache`, and tsconfig-path caches with the source index. Caches are cleared only at session start via the topology-reset registry; mid-session edits are not detected.
