---
section: Added
audience: internal
---

- Add `scripts/mutate.mjs`, a mutation runner that journals the original and mutated sha256, restores its target only while the file still holds the mutated bytes (any other state is refused and reported, never overwritten), and reports RED, SURVIVED or ERROR.
