---
section: Fixed
---

- **ruff `S` (Bandit-equivalent) security rules now run by default, and the
  IaC-misconfiguration lane now actually scans (refs #1757)** — the bundled
  `config/ruff/core.toml` enables `S`, with the sub-rules that over-fired on
  real code (`S101`, `S311`, `S603`, `S607`) excluded and the exclusion
  reasons recorded in the config; a project-local ruff config still overrides
  the bundled one unchanged. Separately, `trivy config` (the existing
  per-edit IaC lane, `clients/dispatch/runners/trivy-config.ts`) was passing
  `--no-progress`, a flag that subcommand rejects — every real invocation
  exited 1 and, because trivy prints usage text to stdout on a rejected flag,
  was misreported as a clean scan rather than an errored one. The lane now
  also covers CloudFormation templates (yaml and json).
