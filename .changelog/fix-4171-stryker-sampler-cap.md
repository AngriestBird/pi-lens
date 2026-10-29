---
section: Fixed
audience: internal
---

- **Stryker nightly bounds its range sample by mutants, not ranges (refs #4171)** — the sampler kept `ranges x allowance / mutants` ranges, which assumes every range holds the same number of mutants; run 40847865852 kept 3 ranges holding 55 mutants against ~24 affordable and exited 1 at the budget. The sample is now counted with a no-test Stryker pass and shrunk, deterministically, until it fits the allowance.
