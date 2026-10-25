---
section: Fixed
audience: user
---

- **A whole-package autofix of a file reached through a link is now recognised as pi-lens's own change** — when the agent wrote `crate-alias/src/main.rs` (a link to `crate/`) and `cargo clippy --fix` or `dart fix` rewrote it, the pipeline compared the agent's spelling with the fixer's real path, concluded the target was unchanged, and drew no post-write state hash for it. The changed-file set is now keyed by the file's real path, so both spellings are one file. Refs #4689.
