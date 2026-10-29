---
section: Changed
audience: internal
---

- The LSP capability nightly records each matrix row's server `version` and `install` source, keeps a missed probe's last known value marked `stale` with its date instead of rewriting it to `unknown`, raises a cell that missed two consecutive nights on one tracking issue, and composes the refresh PR body with its capability flips; with the refresh GitHub App configured the PR starts CI on its own and a flip-free refresh can be armed for auto-merge (refs #4512).
