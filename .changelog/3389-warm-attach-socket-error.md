---
section: Fixed
---

- A pi session serving warm diagnostics to a peer no longer dies when a client
  disconnects mid-reply. Every `requestWarmDiagnostics` timeout, schema refusal
  and validation refusal destroys the client's socket, and the incumbent's
  accepted socket had no `error` listener — so a routine `read ECONNRESET`
  became an uncaught exception in the host. The event is now handled and
  counted in the degradation ledger as `warm-attach-socket-error`, keyed by
  errno (closes #3389).
