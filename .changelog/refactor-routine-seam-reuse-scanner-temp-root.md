---
section: Changed
audience: internal
---

- The ast-grep snippet directories of `dumpAst`, `validatePattern` and `validateRule`, and the helm render scratch directory, now take their parent from `scannerReportParentDir()` like every other `mkdtempSync` scanner directory, so a harness-owned scanner root also catches a directory a killed child strands (refs #4907).
