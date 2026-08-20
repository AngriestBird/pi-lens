---
section: Fixed
---

- **ruff `S` security rules now run by default; the IaC misconfig lane now actually scans (refs #1757)** —
  the bundled `config/ruff/core.toml` enables `S` (Bandit-equivalent), with
  the sub-rules that over-fired on real code (`S101`, `S311`, `S603`,
  `S607`) excluded and the exclusion reasons recorded in the config; a
  project-local ruff config still overrides the bundled one unchanged.
  Separately, two `trivy config` call sites — the per-edit IaC lane
  (`clients/dispatch/runners/trivy-config.ts`) and the Helm
  rendered-manifest pass (`clients/dispatch/runners/helm-render.ts`) — were
  passing `--no-progress`, a flag that subcommand rejects; every real
  invocation exited 1 with trivy's usage text on stdout instead of scanning
  anything. `trivy-config.ts`'s empty-output-only guard missed this
  entirely and reported a clean scan; `helm-render.ts` already checked exit
  status unconditionally, so it failed loud instead, but still never
  scanned a single rendered manifest. Both call sites are fixed, the
  trivy-config runner now treats any nonzero exit as an error regardless of
  stdout content (with a bounded degradation-ledger record so this can't go
  unnoticed again), and the lane now also covers CloudFormation templates
  (yaml and json).
