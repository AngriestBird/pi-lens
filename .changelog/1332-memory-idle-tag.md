---
section: Added
audience: user
---

- **Tag a post-idle `memory_sample` in latency.log.** The first turn that starts after the session sat idle past the LSP idle-evict window now writes one extra `memory_sample` with `idle: true` and `idleMs`, so the main heap can be read after idle. Regular samples carry `idle: false` (#1332).
