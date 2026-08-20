---
section: Fixed
---

- **Coverage-marker dedupe key sorts with an explicit code-unit comparator.** SonarCloud S2871 flagged the bare `.sort()` in the silent-scanner set; the key now sorts locale-independently so dedupe identity cannot vary by environment.
