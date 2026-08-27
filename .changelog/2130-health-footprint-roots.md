---
section: Fixed
---

- **Report every root a host serves in `pilens_health` (refs #2130)** — the resource footprint projected one scalar `projectRoot` per instance, so a host also serving a subagent's temp worktree read as single-rooted there while `instances.json` listed both. Each `resourceFootprint.perInstance` entry now carries `projectRoots`, resolved through `getInstanceRoots` (the single reader the shared-checkout guard already uses), with the pinned primary still in `projectRoot` for existing consumers.
