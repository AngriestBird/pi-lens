---
section: Fixed
---

- **Secret blockers no longer name deleted files (refs #1461)** — Scanner result caches were valid on wall-clock age alone, so a gitleaks finding stayed a 🔴 STOP blocker for the rest of its 30-minute window even after the file it named was deleted. The advisory provenance guard did not catch it: it validates the files the agent edited, not the paths inside the findings. Provenance now also validates finding-cited paths, and gitleaks drops findings whose path is gone rather than demoting them — a deleted file offers no remediation. Findings on files that still exist are delivered unchanged; a finding with no path, an unreadable path, or a path past the stat budget is still delivered. Each drop writes one bounded `finding_dead_path_drop` record to `latency.log` naming the store, the count, and a sample of paths.
