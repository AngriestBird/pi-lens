---
section: Added
---

- **Mechanical lint batch: actionlint, PR-title lint, markdownlint, OSV scan (refs #1844)** — a new `lint.yml` workflow dogfoods actionlint against `.github/workflows/**`, validates that every PR title carries a conventional prefix and an issue reference (`scripts/check-pr-title.mjs`), lints Markdown docs with `markdownlint-cli2` under a repo-tuned config, and runs an advisory weekly `osv-scanner` sweep plus a scan on lockfile-touching PRs.
