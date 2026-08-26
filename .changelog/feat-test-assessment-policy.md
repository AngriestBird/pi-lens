---
section: Changed
---

- **PRs touching tests now carry a Test assessment, and the authoring screens grow to ten** — per touched test file, state what it uniquely pins and what became redundant; removal requires a named surviving test to red on the same mutations. The PR body lint enforces the section (advisory) when the PR touches `tests/`; candidates not deleted in-PR go to the corpus value ledger (#2123). AGENTS.md's test-authoring screens gain four classic vacuity shapes: all-mocks, not-throw-as-sole-assertion, implementation mirror, and snapshot-as-behavior (with the characterization-baseline carve-out).
