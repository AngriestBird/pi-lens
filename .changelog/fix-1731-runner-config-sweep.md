---
section: Fixed
---

- **taplo, biome, stylua, and vulture now prefer the project's own binary and config over pi-lens's managed copy (refs #1731)** — The #1721 sweep found
  the same defect shape in six more runners. taplo's project-local check was
  unreachable whenever pi-lens's managed shim answered first, and even its
  fallback missed an npm-installed taplo on Windows (wrong extension). biome's
  client path returned the first session's auto-installed binary for every
  later project, no matter what that project shipped. stylua had no
  project-local check at all — PATH only. vulture never looked at the
  project's own `.venv`. jscpd and vulture also always passed
  `--min-lines`/`--min-tokens`/`--exclude` (jscpd) and
  `--min-confidence`/`--exclude` (vulture), silently overriding a project's
  own `.jscpd.json`/`[tool.vulture]` thresholds. biome's `--config-path` did
  the same to a project's own `biome.json`, blocking its nested-config
  resolution in monorepos. sqlfluff now spawns with the file's own `cwd`
  instead of the extension host's, so it resolves `.sqlfluff` against the
  right project.
