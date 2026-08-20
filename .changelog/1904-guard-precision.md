---
section: Fixed
---

- **Credit search hits with the lines the search actually showed ([closes #1904](https://github.com/apmantza/pi-lens/issues/1904))** —
  a bare `grep -n` hit registered as a 5-line read, so the read-guard let edits
  pass against lines the model never saw. A hit now credits its match line, plus
  the context the command printed when it carried `-A`, `-B`, or `-C`. Each
  record states the margin it credited and why. The range-snapshot ledger also
  reports the caller's outcome (enforced or bypassed by content match) instead
  of only its intent, and the per-file read store is bounded at 128 records.
