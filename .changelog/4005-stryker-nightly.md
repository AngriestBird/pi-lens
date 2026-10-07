---
section: Changed
audience: internal
---

- **The Stryker mutation lane moves from every pull request to a nightly test-adequacy report (#4005)** — the `mutation (advisory)` and `mutation comment` jobs, the sticky `Mutation diff` comment and ci-verdict's `MUTATION` line are gone; `.github/workflows/stryker-nightly.yml` runs the driver over the runtime diff since the last report and keeps one rolling tracking issue. AGENTS.md now has one PR mutation layer (hand mutation of new guards).
