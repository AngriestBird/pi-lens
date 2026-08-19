---
section: Fixed
---

- **LSP client answers `workspace/diagnostic/refresh` and honors Incremental text sync (refs #1669)** — a server telling us its diagnostics are stale (`workspace/diagnostic/refresh`) previously got `MethodNotFound`; the client now replies `null` and drops both the in-memory `workspacePullResultCache` and the persisted workspace-diagnostics sweep cache, so the next pull recomputes instead of replaying what the server just disowned. Separately, the client always sent whole-document `didChange` events regardless of the server's negotiated `textDocumentSync.change` kind; an Incremental-only server now receives a single ranged edit spanning its entire previous document instead of an out-of-spec shapeless event. `Full`/`None` servers are unaffected.
