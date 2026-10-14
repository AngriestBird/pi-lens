---
section: Fixed
audience: user
---

- **TypeScript language server starts when `tsc` is only on PATH.** A trusted project whose compiler was found on PATH (a bare `tsc`) got no TypeScript server and a warning telling the user to mark the project trusted (#4414). The PATH name is now resolved to the compiler's real location before `tsserver.js` is looked up, and a missing compiler is reported as "no absolute TypeScript compiler could be resolved", not as a trust refusal.
