---
section: Fixed
---

- The marker-root seam's "a nearer project marker created below an
  already-resolved root wins" behaviour is now pinned through the production
  paths that consume it: the real `rust-clippy` runner (so `cargo clippy`
  follows a crate scaffolded by `cargo init crates/engine` mid-session instead
  of staying at the workspace root), the real `BiomeClient` autofix as a
  non-runner consumer, and one derived case over every runner in the marker
  vocabulary baseline. The behaviour itself shipped in #2948; nothing above the
  seam had proven it, and the positive-hit direction was untested (refs #2922).
