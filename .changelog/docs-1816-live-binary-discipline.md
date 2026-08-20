---
section: Changed
---

- **Codified live-binary discipline in AGENTS.md, per maintainer directive** — new defect shape 16 requires every claim about an external tool's exit codes, output shape, or severity vocabulary to be verified against a real run before it ships in code, comments, tests, or rule notes, and requires tool-output fixtures to be captured from real runs, never hand-written. The rule generalizes a pattern from six PRs caught by review in one window: trivy's `--no-progress` rejection read as clean output (#1757/#1781), vulture's real exit code 3 vs. the assumed 1 (#1765), rustc/clippy's six severity levels vs. an assumed two (#1802/#1809), mypy's exit-2 syntax diagnostics (#1822), and biome/pyright field-shape mismatches (#1810/#1809). Also added a one-sentence cross-reference in `skills/pi-lens-write-ast-grep-rule/SKILL.md`'s fixture-validation section.
