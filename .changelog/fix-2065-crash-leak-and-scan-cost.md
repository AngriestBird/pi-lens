---
section: Fixed
---

- **A crashed LSP client no longer pins its retained text forever (refs #2065)** — the client-count Set backing the incremental-text-retention telemetry only deregistered on a graceful shutdown; a crash (connection error, connection close, or an unexpected process exit) never removed the client, so its retained text stayed counted, and reachable, for the rest of the process lifetime. Deregistration now happens in the one place every death path already converges on, so a crash is cleaned up the same way a graceful shutdown is. The per-path `pullGenerations` map, the one member of the close-time cleanup family the original fix missed, is now cleared on `didClose` too. The eviction scan that runs on every `didChange` past the retention cap no longer spreads and scans the full per-path map; it tracks text-bearing paths in their own recency-ordered set instead, so the scan cost stays proportional to the 128-entry cap rather than to the number of open documents.
