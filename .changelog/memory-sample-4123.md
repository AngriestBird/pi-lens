---
section: Fixed
audience: user
---

- **Memory samples distinguish settled heap and major native holders (closes #4123)** — `memory_sample` now reports post-major-GC heap, external memory excluding ArrayBuffers, persist-worker heaps, a named tree-sitter WASM estimate beside source bytes, word-index wire bytes, and sampler overhead.
