---
section: Fixed
audience: user
---

- **A grammar load that never settles no longer strands its language (closes #4224).** `Language.load` is now bounded at 30 s. A load that hangs counts as a failed load: the call returns null, one `grammar-blocked` record names the grammar, and the grammar's retry cooldown keeps later calls from waiting out the bound again. Callers that joined the same in-flight rule-batch build settle with it, so the rules for that language no longer stay stuck for the rest of the process.
