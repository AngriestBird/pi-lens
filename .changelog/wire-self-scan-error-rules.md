---
section: Fixed
---

- **Two error-tier ast-grep rules now run in the CI self-scan** —
  `no-unsafe-dictionary-any` and `no-bare-object-param` shipped at `error`
  without being wired into the `pi-lens-self-scan` category, so pi-lens's
  own tree was never actually audited by them. Both confirm clean (0
  findings) on the full tree (#1825).
