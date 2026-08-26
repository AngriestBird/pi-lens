---
section: Added
---

- **Recover starved CI runs and merge train-approved PRs (closes #2184, closes #2185)** — the merge-train warden classifies every open PR head as runs-concluded-normally, starved-run, absent-run, in-progress, or unknown, re-runs a starved run once, and comments when GitHub drops a dispatch; a new label-gated merge lane lands a `train:approved` PR only when both required checks conclude success on its exact current head.
