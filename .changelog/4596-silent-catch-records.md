---
section: Fixed
audience: internal
---

- The declaration-file walk under a root now records `lsp-declaration-walk-unreadable` when it cannot list a subtree, and keeps that subtree's previous fingerprints instead of reporting its files deleted; an unresolved implicit-scope question records `lsp-implicit-scope-unknown` with the file and cause, and a rejected root deregistration records `instance-registry-deregister-root-failed`. A new `tests/config/silent-catch-sweep.test.ts` ratchets every `catch` handler in the shipped trees to call a record seam or carry a `none: <reason>` line (#4596).
