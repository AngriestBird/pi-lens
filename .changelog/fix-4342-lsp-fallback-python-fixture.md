---
section: Fixed
audience: internal
---

- Test grammars are prefetched once, in parallel, before any worker starts (#4342). The globalSetup now fetches every grammar in the download list, not only the core set, with a bounded timeout per grammar. A stall or failure fails the run once, naming the grammar. The LSP symbol fallback test uses a python fixture instead of dart, which is not a core grammar.
