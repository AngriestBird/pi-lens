---
section: Fixed
audience: user
---

- **Keep source-build tools aligned with the lockfile (#4066).** Both esbuild bundles and the TypeScript fallback use the exact locked versions while retaining isolated npm exec resolution and exact lifecycle-script approval.
