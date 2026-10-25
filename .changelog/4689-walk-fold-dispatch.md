---
section: Fixed
audience: user
---

- **Sibling-package files reached through a directory link no longer pick up the wrong package's Cargo workspace, git repository or package root** — eight hand-rolled upward walks now climb the path identity through the shared `walkUpDirs` (#4689): the Cargo inherited-edition climb and its `$HOME` ceiling (a home that is itself a link no longer lets a workspace manifest above it through), the runner path resolver, the `.shellcheckrc` and `.vale.ini` finders, the metrics history's git check (a file in a linked directory recorded its commit as `unknown`), the package root and the ast-grep `node_modules` search. The project-root walk of the startup scan keeps its spelling by design and moves onto the same helper unchanged.
