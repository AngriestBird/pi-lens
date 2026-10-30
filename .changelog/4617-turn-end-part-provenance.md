---
section: Fixed
audience: user
---

- **A bash-only turn no longer labels its fresh turn-end findings historical (refs #4617).** The provenance stamp now speaks for every part the message carries: each file-bound producer registers the files its text reports (the stale-secrets tier, knip, dead-code, trivy's scanned dependency declarations, call-graph impact, the actionable and code-quality warning advisories, the demoted inline blocker, the cascade test suggestions), and a part with no file it could be stale against — a runner crash note, a suppressed-count notice — is stamped current for the turn that produced it. A part carried from an earlier turn, or one that declares neither, still reads "Historical finding; workspace changed since capture", and `tests/config/turn-end-part-provenance-census.test.ts` fails when a new turn-end producer declares nothing.
