---
section: Added
---

- **Live native-TS7 diagnostic fixture (refs [#1412](https://github.com/apmantza/pi-lens/issues/1412))** — an opt-in (`PI_LENS_INTEGRATION=1`) integration suite launches the real `tsc --lsp` server against a Vitest-typed fixture, asserting no `Mock`/`mockResolvedValueOnce` false positives after settling while an intentional type-error control still surfaces, and recording the publication/settle sequence.
