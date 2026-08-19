---
section: Added
---

- **One primitive for "at most one execution per key" replaces ten hand-rolled copies (closes #1753)** — Ten sites
  wrote the same five lines by hand, and four bugs came out of the copies: a
  leak guard no test exercised (#1690), a late completion that evicted its own
  successor (#1674), a trailing-rerun bit that shipped unpinned (#1687), and a
  latch its own mutation matrix deleted as vacuous (#1722). `singleFlight` now
  owns the share, the clear on both settlements, the successor check, and the
  trailing-rerun coalescing, with a six-mutant matrix proving each guard reds a
  test. Biome and ast-grep availability are converted first; their existing
  tests, including #1690's leak proof, pass unchanged. A ratchet test fails any
  new hand-rolled in-flight state that does not carry a reason.
