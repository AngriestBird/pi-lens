---
section: Fixed
audience: user
---

- **The read guard no longer lets another writer's change ride on a file the agent wrote.** A file the agent wrote (by `write`, edit or a recognized bash command) stays editable without a re-read only while it still holds the bytes the agent wrote: `touch` or a checkout of identical bytes keeps it, another writer's change ends it, and a later bash write, format, or extension-reported write does not revive it (#4131). That authorship now survives `/tree`, `/fork` and resume when the branch still shows the write (#3603). Process-bridge writes, observed tool writes and partial bridge reads no longer mark the whole file as freshly read (#3865).
