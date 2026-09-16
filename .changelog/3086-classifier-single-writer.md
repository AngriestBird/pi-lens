---
section: Removed
---

- **`decideClassifierAction` in `ci-failure-classifier.mjs` (refs #3086)** — a pure duplicate of `runClassifier`'s carry-forward rule (rerun eligibility, `rerunState`, which run attempt a carried-forward marker belongs to) with no production caller; #3079 had needed a twin test case to keep both writers honest after a mutation on `runClassifier`'s copy alone stayed green. `runClassifier` is now the sole writer of the rule, and its existing test covers the mutation on its own.
