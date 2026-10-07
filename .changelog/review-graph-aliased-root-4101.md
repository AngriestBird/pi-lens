---
section: Fixed
audience: user
---

- The review graph no longer loses every relative import edge when the project root is spelled through a Windows 8.3 short name, a junction or a `subst` drive (or, on a case-insensitive mount, a mis-cased directory): impact cascades, `directImporters` and import-based call resolution keep working, and graph feature hints are derived from the project-relative path instead of an absolute one (#4101).
