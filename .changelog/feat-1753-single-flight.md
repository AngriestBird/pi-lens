### Added

- `singleFlight`, one primitive for "at most one execution per key, cleared when
  it settles" (#1753). Ten sites hand-rolled that shape, and four bugs came out
  of the copies: a leak guard no test exercised (#1690), a late completion that
  evicted its own successor (#1674), a trailing-rerun bit that shipped unpinned
  (#1687), and a latch its own mutation matrix deleted as vacuous (#1722). The
  primitive owns those four guards once, with a mutation matrix proving each one
  reds a test. `BiomeClient.ensureAvailable` and `SgRunner.ensureAvailable` are
  converted; their existing tests, including #1690's leak proof, pass unchanged.
  A ratchet test fails new hand-rolled in-flight state unless it carries a reason.
