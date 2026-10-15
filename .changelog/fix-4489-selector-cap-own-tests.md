---
section: Fixed
audience: internal
---

- The pre-push test selection keeps the change's own tests when it caps (#4489). A changed test file and the mirrored test of each changed source file now survive the 25-file cap and do not count against it. The cap keeps the best 25 import matches instead of none, ranked by fewest importers of the changed file first (specific files outrank hubs), ties by path. The capped warning and the header describe the rule. Replaying the 20 newest merged PRs recalls 113 of 113 own test files, up from 31.
