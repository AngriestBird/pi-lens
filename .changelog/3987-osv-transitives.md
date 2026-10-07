---
section: Security
audience: internal
---

- Update four vulnerable development transitive dependencies and bump the dev pi host to 1.0.4 (it shipped an `npm-shrinkwrap.json` pinning the vulnerable brace-expansion), so the lockfile and the installed tree carry none of the six OSV findings reported by the pinned scanner (closes #3987).
