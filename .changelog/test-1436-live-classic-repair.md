---
section: Added
---

- **Live classic-TypeScript repair fixture (refs [#1436](https://github.com/apmantza/pi-lens/issues/1436))** — an opt-in (`PI_LENS_INTEGRATION=1`) integration suite stages a real managed-tools tree in the reported broken shape (TypeScript 7 with no `lib/tsserver.js`, cached by a prior probe) inside an isolated `PI_LENS_HOME`, then drives the production spawn through the real installer: it asserts the version-gated repair fires exactly once, the tree self-heals to the pinned classic compiler, and the classic launch serves diagnostics again. A negative control proves a disallowed-install spawn stays discovery-only and mutates nothing.
