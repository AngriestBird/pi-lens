---
section: Fixed
audience: user
---

- **A worktree with no `node_modules` no longer renders its missing `@types/node` as STOP blockers**, and the install look now runs at the language server's own root. TS2307 on a `node:` or bare specifier, TS2503 for `NodeJS` and TS2304 for `node`'s globals are demoted to warnings with a label naming the missing dependency install when the file resolves no `node_modules`; every other code, server and root keeps blocking. The out-of-band install look gained the client-root `since` epoch and a `livePrimaryClientRoots` accessor for the linked-worktree case (refs #4532).
