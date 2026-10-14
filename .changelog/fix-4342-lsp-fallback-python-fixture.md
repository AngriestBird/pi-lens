---
section: Fixed
audience: internal
---

- Test grammars are prefetched once, in parallel, before any worker starts (#4342). The globalSetup fetches every grammar in the download list that no runtime grammar directory already holds. Each fetch stops after 15 s with no bytes and retries once on a retryable failure. A grammar still missing fails the run under CI and warns once locally, naming every grammar. The LSP symbol fallback test uses a python fixture instead of dart, which is not a core grammar.
