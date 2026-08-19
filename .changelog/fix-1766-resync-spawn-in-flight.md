---
section: Fixed
---

- **LSP resync timeout no longer blames a server still spawning (closes #1766)** — When the pre-dispatch resync's wait budget expired while a language server's first spawn was still in progress, the log wrongly read "server slow/wedged" — a verdict about a running server, not a cold start. The record now emits `reason: "spawn-in-flight"` and says the server is still cold-spawning when that is the case, and keeps the "slow/wedged" wording only when no spawn is in flight.
