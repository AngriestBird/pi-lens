---
section: Fixed
---

- **Canonicalize test-runner cache roots (refs #2048)** — Test-runner availability and Vitest glob caches now share project identity across path aliases, while positive runner verdicts expire when their supporting config disappears.
