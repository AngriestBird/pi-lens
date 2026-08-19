---
section: Fixed
---

- **Two more `index-*-wiring` test files budget their cold import (closes #1778)** — `tests/index-memory-sample-wiring.test.ts` and `tests/index-smells-rollup-wiring.test.ts` share #1772's flake shape: a cold `await import("../index.js")` after `vi.resetModules()` per test, racing vitest's 5000ms default `testTimeout`. Both describe blocks now declare an explicit 30s timeout, matching #1779's `index-loop-block-wiring` fix and this repo's `HEAVY_IO_TIMEOUT_MS` convention, instead of hoisting the import — hoisting would defeat the per-test module-state isolation these wiring guards check. `tests/index-integration.test.ts` and `tests/index-lsp-idle-reset.test.ts` (the other two files in #1778's sweep) already carry an equivalent per-test 45s timeout and needed no change.
