---
section: Changed
audience: internal
---

- **Contributor docs gain a per-case class rule for `PI_MOCK_IMPORTERS` and a census rule for the defect-shape catalog (#4709).** AGENTS.md "Test requirements" states that a row's class holds for a whole file only while every case in it needs that class, and that a spawn, pipeline-runner, or LSP-service double is `process-boundary` rather than `internal-seam`. The "Recurring defect shapes" preamble asks each countable shape to name its census, and shape 66 names the `in-process-mock` key of `tests/support/flake-shape-baseline.json` (1009 rows on master 33eac2aa1) with #4709 as the issue that lowers it. No row of the admit list is re-classed here.
