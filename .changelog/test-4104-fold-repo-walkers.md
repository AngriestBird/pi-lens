---
section: Changed
audience: internal
---

- The tests-tree walker (`testSourceFiles`), the atomic-write scan's `clientSourceFiles` and the win32 gate population now walk through one shared walker, `scripts/lib/walk-files.mjs`, which `listSourceFiles` also uses. A directory that a sibling process removes mid-walk is skipped and recorded instead of failing the sweep, and `.git`, `.probe-home`, `.claude` and `node_modules` are never entered (#4104, sibling of #4097). The tree-scanner census and the sweep-floor enumeration now recognise `walkFiles`, so a test-support module walking through it is still counted.
