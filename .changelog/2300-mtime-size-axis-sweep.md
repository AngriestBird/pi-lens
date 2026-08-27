---
section: Fixed
---

- **Add a size axis to five mtime-only content memos (closes #2300)** — The MCP warm-build staleness gate, the LSP diagnostic-binding content-hash memo, the workspace-diagnostics per-file freshness cache, the cross-process recent-touches watermark, and the installer's tool-path probe cache now all validate byte size alongside mtime, so an external rewrite landing in the same coarse-granularity mtime bucket with a different length is no longer served as unchanged. Every fix reuses a stat call already being made — no added per-edit I/O.
