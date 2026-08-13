---
section: Changed
---

- **TypeScript language services release idle program memory (refs #1332)** — After five inactive minutes (configurable with `PI_LENS_TS_IDLE_EVICT_MS`), TypeScript LSP clients shut down and rebuild transparently on the next request instead of retaining fully hydrated programs indefinitely.
