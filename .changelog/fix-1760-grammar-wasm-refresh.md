---
section: Fixed
---

- **Tree-sitter grammar wasms now refresh when the pinned version moves (refs
  #1760)** — a grammar wasm downloaded once was never replaced when this repo
  bumped the version it pins, because the cached file's name carries no
  version. A future fix to a broken grammar build (the class #255 and #427
  already hit) would never reach a machine that had already downloaded the
  broken one. pi-lens now compares each cached grammar's sha256 against the
  currently pinned manifest (`scripts/grammars.lock.json`) before trusting it,
  memoized per file so steady state costs no extra hashing and never touches
  the network. A mismatch is treated as a missing file: the existing lazy
  fetch re-downloads it, verifying and atomically swapping in the new build,
  so a failed re-download never destroys the working cached copy. This also
  catches on-disk corruption, which nothing detected before.
