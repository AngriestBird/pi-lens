---
section: Fixed
audience: user
---

- **A directory whose name starts with `..` is no longer read as outside its project.** Ten containment tests compared `path.relative` text with `startsWith("..")`, so a file under `<root>/..pkg/` was classed outside the root: its nested `.pi-lens.json` was not read, a hosted LSP client was not reused, a Cargo workspace member kept its own root, a rendered Helm file fell back to Chart.yaml, a mirrored test was not found, a Knip or madge shim was labelled `global`, a stale finding was not retired, and the MCP turn-end route refused the cwd. They now share `isUnderDir`, `isWithinForm`, `isWithinPathForm` and `toProjectRelativePath` from `path-utils.ts` and `file-utils.ts` (refs #2556).
