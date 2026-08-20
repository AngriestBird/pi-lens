---
section: Fixed
---

- **Managed tools from GitHub releases, pip, gem, archives and Maven now refresh too (refs #1747)** —
  #1730 unfroze the npm-installed tools. The other 39 managed tools stayed on
  whatever version pi-lens resolved the day it first installed them, because
  the installer only runs when a tool is absent. A stale ast-grep, ruff,
  gitleaks or terraform-ls produces exactly the wrong verdicts #1730
  documented for knip. All five remaining strategies now share the same
  weekly per-tool cadence, the same one-refresh-per-session budget and the
  same degradation record as the npm path. GitHub tools re-resolve
  `releases/latest` with a stored `ETag`, so an unchanged release downloads
  nothing; archive and Maven tools compare the version pinned in pi-lens's
  own registry and touch the network only when it moved; pip and gem tools
  re-run their install command in upgrade form. A refreshed binary that
  cannot report a version is treated as a failed refresh, not a success. Set
  `PI_LENS_DISABLE_TOOL_REFRESH=1` to turn the whole mechanism off.
