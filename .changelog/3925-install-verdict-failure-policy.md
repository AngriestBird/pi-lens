---
section: Changed
audience: internal
---

- **The required `install-test` verdict steps are pinned against tolerated failure (refs #3925)** — `tests/config/sharded-aggregate-failure-policy.test.ts` now asserts by name that `Install from tarball`, `Verify required files in tarball`, `Verify package.json entry points exist in tarball`, `Verify bundled core grammars shipped in the tarball`, and `Load each extension entry point` keep `continue-on-error` false, so a tolerated step can no longer green that matrix leg's required check while the two declared best-effort steps stay allowed.
