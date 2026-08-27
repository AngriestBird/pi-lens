---
section: Fixed
---

- **Baseline the git-config contamination guard against pre-suite identity (refs #2251)** — the test-teardown guard no longer fails every local run for a maintainer whose real git identity happens to equal a fixture value (`user.name=t`, `user.email=t@t.local`). It snapshots the config before any test runs and flags only fixture values that appear during the run, so real contamination still fails loudly.
