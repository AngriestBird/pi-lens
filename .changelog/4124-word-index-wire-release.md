---
section: Fixed
audience: user
---

- **The word index no longer holds its serialized copy while idle.** It is released when the agent run settles (once per run), kept while a run edits so per-edit saves stay incremental, and released after 10 minutes without a save for a stalled run (`PI_LENS_WORD_INDEX_MEMO_BACKSTOP_MS`).
