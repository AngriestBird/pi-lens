---
section: Changed
audience: internal
---

- Key the durable test-history journal by one repo-relative posix path instead of vitest's absolute runner path, so one test keeps one history across checkout roots and OS path styles (rows already on the data branch are normalized on read), and add a history pass to the pre-push and advisory test selection that adds the tests which failed on past heads touching the changed directories, read from the rollup's new `failures` summary and skipped with a disclosed reason when that summary is stale or absent (closes #3367, refs #3215).
