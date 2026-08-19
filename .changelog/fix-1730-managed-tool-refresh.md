---
section: Fixed
---

- **Managed tools now refresh instead of drifting stale (refs #1730)** —
  pi-lens installed each managed npm tool once and never re-resolved it, so the
  copy it ran could be many minor versions behind what its own recorded range
  permits. A managed knip 28 minors behind reported 62 unused exports on a tree
  the project's own knip reported clean, and acting on flags like those deletes
  live code. pi-lens now re-resolves one managed tool per session, at most once
  a week per tool, on a background timer that never blocks startup. Every
  refresh records the version it moved from and to in
  `~/.pi-lens/sessionstart.log`; a refresh that fails leaves the installed
  version serving and records one degradation rather than blocking the tool.
  Set `PI_LENS_DISABLE_TOOL_REFRESH=1` to turn it off.
