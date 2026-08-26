---
section: Fixed
---

- **`vi.stubEnv` leak sweep undercount (refs #2090, closes #2223)** — `reverse-deps-cache.test.ts` now unstubs `PI_LENS_REVERSE_DEPS_IDLE_EVICT_MS` in its `afterEach`, the second live instance of the #2090 leak class that the original sweep missed. `check-pr-body.test.ts`'s "renames out of tests/" test unstubbed its GitHub env stubs only after its assertion, so a failing assertion would have left them stubbed for later tests; it now unstubs in `afterEach` like every other describe block in the file.
