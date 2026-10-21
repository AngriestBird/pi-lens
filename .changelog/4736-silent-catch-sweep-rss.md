---
section: Fixed
audience: internal
---

- **Turn the event loop between files in three AST sweeps.** The silent-catch, env-path-key and lsp-service-double sweeps held every parsed native tree at once (1,902, 1,703 and 1,715 MB peak RSS of a 2,048 MB budget); the peaks are now 250, 272 and 452 MB with identical findings, so source growth no longer reds Unit shard 2/5 (#4736).
