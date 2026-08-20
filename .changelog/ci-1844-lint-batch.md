---
section: Added
---

- **Mechanical lint batch: actionlint, PR-title lint, markdownlint, OSV scan (refs #1844)** — a new `lint.yml` workflow dogfoods actionlint against every workflow file, validates that every PR title carries a conventional prefix and an issue reference **in the title itself** (`scripts/check-pr-title.mjs` — a reference living only in the PR body no longer counts, since it never reaches the merge-commit subject), and lints Markdown docs with `markdownlint-cli2` under a repo-tuned config. A separate `osv-scan.yml` runs an advisory weekly `osv-scanner` sweep plus a scan on lockfile-touching PRs, writing results to the job summary.
