---
section: Fixed
---

- Runner parsers for taplo, yamllint, htmlhint, and oxlint now attribute a
  diagnostic only when the tool-reported path matches the dispatched file from
  the runner's cwd (refs #3295, #3278, #1193).
