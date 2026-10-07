---
section: Fixed
audience: internal
---

- Scripts that read Vitest console output (the pre-push hook's recorded counts, `lane:check`, `scripts/mutate.mjs`, `scripts/ci-test-diff.mjs`, the Windows failure count and the `ci-verdict` red-row label) now share one parser, `parseVitestSummary`, that strips ANSI, Actions timestamps and CRLF first. The pre-push record read `passed: 0, failed: 0` for a coloured red run (#4087).
