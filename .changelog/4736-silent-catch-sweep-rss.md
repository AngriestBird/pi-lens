---
section: Fixed
audience: internal
---

- **Turn the event loop between files in the silent-catch sweep.** Its synchronous walk held every parsed native tree at once (1,902 MB peak RSS of a 2,048 MB budget); the peak is now about 250 MB with an identical finding list, so source growth no longer reds Unit shard 2/5 (#4736).
