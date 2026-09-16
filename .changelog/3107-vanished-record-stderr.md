---
section: Fixed
---

- **Vanished-file diagnostic reaches the run log on a passing suite (refs #3107)** — `tests/support/sweep-kit.ts`'s `readWalkedFile` and its `scripts/lib/win32-gate-population.mjs` twin recorded a walked file that vanished between list and read with `console.warn`, but Vitest's default reporter (every `npm test` script uses it) intercepts and can drop a worker's `console.warn` on a green run, so the record never actually reached CI's job log despite the docstring's claim that it does. Both sites now emit through a raw `process.stderr.write`, matching the same interception fix already documented at `tests/support/vitest-setup.ts`'s peak-RSS reporting. The `.mjs` twin's hand-rolled `Set` with `clear()`-on-overflow eviction — which its own parity comment falsely claimed was "identical" to the TypeScript seam — now shares the TypeScript seam's `BoundedSet` (oldest-first eviction), making the claim true.
