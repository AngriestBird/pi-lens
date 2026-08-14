---
section: Fixed
---

- **Cascade module source-file walk is memoized on the existing freshness seams (refs [#1137](https://github.com/apmantza/pi-lens/issues/1137))** — `getModuleSourceFiles` (the #1318 slice-2 remnant) ran a recursive `readdirSync` walk per downstream module on every per-edit cascade in monorepos; it now memoizes per module root, revalidating on the visited directories' `mtimeMs` stamps plus ignore-matcher object identity (so `.gitignore`/`.pi-lens.json` edits re-walk), and clears with the module-graph cache.
