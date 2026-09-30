---
section: Fixed
---

- **Node tool agreement now reads pnpm and yarn lockfiles (refs #3655)** — Projects that declare a Node formatter or linter in `package.json` and resolve it through `pnpm-lock.yaml` (v9 workspaces and v6) or `yarn.lock` (v1 and Berry) now establish tool agreement exactly as npm projects do, so autofix and formatting run instead of declining with no visible change.
