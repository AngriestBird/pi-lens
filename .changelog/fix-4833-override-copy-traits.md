---
section: Fixed
audience: user
---

- **A `serverOverrides.<id>.command` no longer runs under measurements of the catalog binary** — the override kept every measured trait of the built-in server row it replaced: idle eviction, notify reply ordering, dependent-file propagation, and the wait strategy keyed by server id (`silentOnClean`, `emptyFirstPublish`, `diagnosticsFence`, `workspaceIndexing`, the wait budgets). The override now keeps only the row's routing identity, its protective guards and its wait budgets; every other trait resets to its fail-safe default, so a swapped binary is waited on conservatively and is never evicted on another binary's evidence (#4833).
