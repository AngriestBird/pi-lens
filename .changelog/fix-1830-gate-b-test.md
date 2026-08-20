---
section: Fixed
---

- **ast-grep-napi LSP supersede gate B tests now pin the gate, not the fallback (closes #1830)** — the two "skips ..." tests under `LSP supersede gate (#239 Phase 2)` mocked `@ast-grep/napi` with a bare `parse: vi.fn()`, so a neutered gate B still returned `"skipped"` by falling through to the load/parse skip path. `expect(result.status).toBe("skipped")` couldn't tell the two skip reasons apart, so the tests passed whether gate B fired or not. A `mockWorkingSgLoad()` helper now makes the NAPI fallback path succeed, so only gate B can still produce `"skipped"`. Neutering the gate's `.includes("ast-grep")` check now turns both tests red with `"succeeded"`, confirming the assertion is load-bearing.
