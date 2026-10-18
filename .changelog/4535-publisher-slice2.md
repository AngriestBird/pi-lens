---
section: Changed
audience: internal
---

- The HEAD look and the bash write path now publish one `DiskChange` (`clients/disk-changes.ts`) instead of calling the LSP service and driving the held-primary send and the detached drift pass themselves. `sendToHeldPrimaries` and its drift call moved into the publisher's LSP consumer (`clients/disk-change-subscribers.ts`), so neither detector names a consumer, and a publish that reaches no LSP subscriber records one bounded `disk-change-lsp-consumer-missing` row per root instead of reading as "no held document was stale". This is slice 2 of #4535 (detector migration); the consumer census, the staleness markers, the settled sweep, the drift heartbeat and the MCP route follow in slice 3.
