---
section: Fixed
audience: user
---

- **A turn-end finding captured in the current turn is no longer labelled "Historical finding; workspace changed since capture" on a turn that wrote no file (refs #4617).** The provenance stamp now speaks for every part the message carries: each file-bound producer registers the files its text reports (the stale-secrets tier, knip, dead-code, trivy's dependency manifests, call-graph impact, the actionable and code-quality warning advisories, the demoted inline blocker, the cascade test suggestions), and a part with no file it could be stale against — a runner crash note, a suppressed-count notice — is stamped current for the turn that produced it. A part carried from an earlier turn, or one that declares neither, still reads historical, and `tests/config/turn-end-part-provenance-census.test.ts` fails when a new turn-end producer declares nothing.
