---
section: Changed
audience: internal
---

- **Drop seven LSP server arms no assertion reads.** Seven LSP test files armed a fake server list through `_setServersForFileForTests` that no assertion observed; the arms and their fakes are removed, and the two files whose arm stops a real server spawn keep it (#4709).
