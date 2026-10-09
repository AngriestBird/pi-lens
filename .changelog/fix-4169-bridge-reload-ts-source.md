---
section: Fixed
audience: user
---

- **Bridge reads survive a `/reload` on the TypeScript-source extension load.** A third-party read recorded after `/reload` (`pi -e index.ts`) now licenses the next edit instead of being falsely blocked with "Edit without read" (refs #4169).
