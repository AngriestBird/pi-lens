---
section: Fixed
---

- **Stop a routine paging repeat from reddening the merge-train warden (refs #2192)** — the warden's PR reader orders by `UPDATED_AT`, so a PR updated mid-pagination lands on the next page too. That boundary repeat was recorded as a fatal error, once per repeated node, so a fully shifted window could emit up to 200 identical red lines in one 10-minute run. It is now one record per page naming the count, classified by cursor: a repeat with an advancing cursor is benign, a repeat with a stalled cursor stays fatal because it is real truncation. `fetchOpenPullRequests` returns `{ message, benign }` records, so the warden and the merge lane read one classification instead of each deciding for itself.
