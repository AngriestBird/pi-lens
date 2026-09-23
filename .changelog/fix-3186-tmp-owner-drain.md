---
section: Fixed
---

- The temporary-fixture hygiene sweep now waits for live test owners to finish
  their bounded cleanup drain and attributes remaining entries to the owner
  file, preventing cross-worker false leaks without adding prefix admissions
  (refs #3186).
