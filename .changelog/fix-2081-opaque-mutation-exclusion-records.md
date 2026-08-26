---
section: Fixed
---

- **Opaque-mutation exclusion counter overstated suppression (closes #2081)** — `excludedIncomingCount` incremented for every clean-index-only entry dropped by the failed-integration filter, even when the entry's mtime fell outside the recovery window and it was never going to be dispatched. It now counts an entry only when the mtime-freshness check would otherwise have included it, so the field means what its doc comment claims: dispatches actually prevented. Added a test asserting the `opaque_mutation_status_pair_unknown` latency record's emission and phase identity through the `logLatency` seam, alongside the existing `opaque_mutation_incoming_excluded` coverage — renaming either phase string now reds a test.
