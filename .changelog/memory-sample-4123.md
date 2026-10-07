---
section: Fixed
audience: user
---

- **Memory samples distinguish settled heap and major native holders (closes #4123)** — `memory_sample` now reports the latest major-GC heap reading with its GC count, external memory excluding ArrayBuffers, persist-worker heaps, tree-sitter source bytes, persisted word-index wire bytes, and sampler overhead.
