---
section: Changed
---

- The three cached scanner lanes turn_end reads — gitleaks, trivy secrets and
  govulncheck — now share ONE cited-path freshness pass instead of calling the
  gate once each (refs #1892). A file both secret scanners flag was stat'd
  twice, spent two separate stat budgets and wrote two
  `finding_stale_line_demote` rows for one decision about one file; it is now
  one stat, one budget and one bounded record per delivery, carrying a
  `byStore` breakdown so the row still says which store's findings were
  retired. Source identity survives the fold: each store's own `scannedAt`
  decides its own findings' staleness, and each store's own missing-path policy
  decides its own findings' deletion, so a govulncheck CVE still survives a
  deleted call site on the same path that drops a gitleaks secret. Scanner
  cache records written by 4.2.1 parse and render unchanged.
