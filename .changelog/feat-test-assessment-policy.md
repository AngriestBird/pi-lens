---
section: Changed
---

- **PRs touching tests now carry a Test assessment** — per touched test file, what it uniquely pins and what became redundant; removal requires a named surviving test to red on the same mutations. The PR body lint enforces the section (advisory) when the PR touches `tests/`; candidates not deleted in-PR go to the corpus value ledger (#2123).
