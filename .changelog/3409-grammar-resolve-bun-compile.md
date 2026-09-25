---
section: Fixed
---

- **Non-core tree-sitter grammars on a compiled host (closes #3409)** — On a
  runtime that cannot resolve a bare package specifier — pi ships as a
  `bun build --compile` binary — pi-lens could not work out where to put a
  lazily fetched grammar, so no non-core language (C#, C++, OCaml, …) could
  ever be analysed: symbol search, module reports and structural rules stayed
  degraded forever while the notification blamed package-manager build scripts
  and the network. Both the read and the write path now resolve web-tree-sitter
  through a subpath that works there — and only accept a directory that really is
  that package, so a fetched grammar can never land in an unrelated tree — the
  report names the real cause (nothing resolved, or the directory is not
  writable), a tree-sitter run whose grammar never loaded is recorded as a skip
  instead of a clean pass, and `scripts/install-selftest.mjs` stops reporting the
  grammar asset missing on those same hosts.
