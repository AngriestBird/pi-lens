---
section: Changed
---

- **In-session LSP root walks stop at the session root (refs [#1412](https://github.com/apmantza/pi-lens/issues/1412))** — Root discovery no longer probes ancestors that the session root ceiling would reject. Out-of-session files retain unbounded discovery, and uncached misses still detect newly scaffolded project markers. A gated live native TypeScript 7 fixture covers Vitest globals and mock types with an intentional diagnostic control.
