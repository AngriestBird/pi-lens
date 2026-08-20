---
section: Fixed
---

- **`lens_diagnostics` no longer double-counts error findings (closes #1799)** — The compact
  header and the mode=all/full summary printed the same error-severity findings
  twice, once as "blocking" and again as "errors", making three real problems
  read as six. `semantic === "blocking"` and `severity === "error"` always
  describe the same set of findings, so both surfaces now report blocking and
  warnings only. Also removed the always-zero `byTier.error` field from
  `clients/actionable-warnings.ts`, since error-severity diagnostics never
  reach the actionable-warnings path.
