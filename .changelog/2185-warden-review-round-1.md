---
section: Fixed
---

- **Match the merge lane to live repository state (refs #2185)** — the lane updates a green branch that is behind instead of attempting a merge master protection would refuse, reads the `(advisory)` name suffix this repository actually uses, resolves duplicate check names to the newest run, requires the `train:approved` label to come from an approver, and deduplicates its merge-failure comment.
