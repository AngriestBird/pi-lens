---
section: Changed
audience: internal
---

- **Drop five redundant LSP server arms (#4709).** Seven test files were reviewed. Five no longer need the injected server list, because the real registry answers what the fake did. Two keep it, because without it a real server would spawn.
