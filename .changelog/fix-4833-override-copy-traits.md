---
section: Fixed
audience: user
---

- **A `serverOverrides.<id>.command` no longer runs under measurements of the catalog binary** — the override kept every measured trait of the built-in server row it replaced: idle eviction, notify reply ordering, dependent-file propagation, and the wait strategy keyed by server id. The override now keeps the row's routing identity, its protective guards, its wait budgets and the protocol workarounds that make a scan wait longer (opengrep's re-open on edit and its hold on the pre-rules empty publish, for example), and resets every optimistic claim (idle eviction, reply ordering, `silentOnClean`, `seedFirstPush`, shorter budgets) to its fail-safe default (#4833).
