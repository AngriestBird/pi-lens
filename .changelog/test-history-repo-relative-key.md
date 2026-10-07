---
section: Changed
audience: internal
---

- Key the durable test-history journal by one repo-relative posix path instead of vitest's absolute runner path, so one test keeps one history across checkout roots and OS path styles; rows already on the data branch are normalized on read, and the history-based test selector reads that key and adds the failing tests of past heads that touched the changed directories to the pre-push and advisory selections (closes #3367, refs #3215).
