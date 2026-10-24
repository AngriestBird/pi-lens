---
section: Fixed
audience: user
---

- **A HEAD move, a bash rewrite or a swept change now refuses cached diagnostics that depend on it.** The diagnostics cache heard only the dependency-install and declaration-file look, so an unchanged importer of a file rewritten by a checkout kept serving its pre-change findings. It now hears every detector, and the settled sweep also tells the language servers about a file nothing explains (#4535).
