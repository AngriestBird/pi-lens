### Fixed

- A cascade's neighbor re-check no longer notifies auxiliary scanners
  (ast-grep, opengrep, typos) for every changed neighbor. A neighbor's
  content did not change — only its import target did — so an auxiliary
  scanner's file-local verdict for it cannot have changed, and the cascade's
  own merge already discarded any aux re-derivation by construction. The
  touch now uses `clientScope: "primary"` (language server only), matching
  the sibling tier-aware touch. Measured on a representative slow-aux
  fixture: 0 aux notifies per neighbor (was 1 per configured auxiliary) and
  a ~850ms per-neighbor conclusive-latency drop (900ms to 50ms) when an aux
  scanner is slow to answer. (#1720)
