---
section: Changed
---

- **Workspace-scope LSP queries identify their serving client ([refs #1854](https://github.com/apmantza/pi-lens/issues/1854))** —
  the existing `lsp_navigation_result` latency record now names the LSP server
  that answered each no-path workspace query. Aggregated operation support
  records a bounded per-capability contributor map, so multi-primary routing
  defects are visible without adding another log surface.
