---
section: Fixed
---

- **Git installs start about 750ms faster (refs #1926)** — pi supplies `typebox` and `@earendil-works/pi-tui` from its own runtime, but pi-lens declared both as runtime dependencies. A `git:` install therefore vendored a private second copy of each, and Node evaluated that whole extra module graph every time the extension loaded. Both are now optional peer dependencies, so nothing vendors them. The `PI_TIMING` module import for the dogfood git install drops from 941ms to 147-196ms, and the extensions block drops from 2165ms to 1449ms.
