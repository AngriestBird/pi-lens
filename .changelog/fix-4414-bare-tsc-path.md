---
section: Fixed
audience: user
---

- **TypeScript language server starts for a compiler found only on PATH.** A trusted project whose `tsc` resolves through PATH to a normal TypeScript package (nvm, Homebrew, npm-global) now gets the TypeScript server, where it was reported as "mark the project trusted" (#4414). When the PATH `tsc` is TypeScript 7 or a shim with no package beside it (volta, asdf, mise, pnpm-global), pi-lens installs its own pinned classic compiler if installs are allowed. A missing compiler now warns that no compiler could be resolved, and a genuine trust refusal still prints only the trust notice. The first line of multi-match Windows `where` output is read without its carriage return.
