---
section: Fixed
audience: internal
---

- The test runner's failed-target and project-root keys, and the actionable-warning fix's one-file guard, now derive path identity through `clients/path-utils.ts` instead of a raw `realpathSync`: a project root that does not exist yet is keyed by its identity through either spelling, and a quick fix whose edit names a second file that is not on disk is skipped as `multi_file_edit` instead of `apply_failed` (#4689).
