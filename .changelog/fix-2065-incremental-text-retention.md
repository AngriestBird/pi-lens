---
section: Fixed
---

- **Incremental LSP document text is bounded and released on close (refs #2065)** — full text retained for incremental synchronization is capped at 128 paths and 64 MiB of UTF-16 data, evicts least-recently-sent paths, and is removed with the other per-document state on `didClose`. Periodic `memory_sample` records now expose retained entries and bytes.
