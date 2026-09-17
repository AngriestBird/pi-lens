---
section: Fixed
---

- **The skills-directory degradation record no longer drops which entry file triggered it (refs #3175)** — when `resources_discover`'s `skills/` lookup misses, the ledger's `reason` field concatenated a classification that repeats `skillsDir` (already recorded verbatim in `subject`) ahead of the entry file's directory — the one fact the record uniquely carries for diagnosing a managed-cache-relocated entry (#2587). Once the shared root was long enough that the two exceeded the ledger's 200-char cap (a real dry-roll/CI-lane TMPDIR shape), the head-preserving truncation kept the redundant path and silently dropped the entry directory. The ledger's copy of the reason now uses a short, path-free classification tag instead, leaving room for the entry directory to survive intact; the user-facing notification is unaffected.
