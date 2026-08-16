---
section: Fixed
---

- **A slow first probe no longer disables an installed tool (closes #1476)** —
  biome, ast-grep, Go, cargo and govulncheck now tell a probe timeout apart from
  a missing install, the way knip and madge already did. Before this, one stalled
  second at session warm-up latched "tool is not installed" for the life of the
  process, and biome and ast-grep also paid for an auto-install nobody needed. A
  transient verdict now expires and the tool comes back without a restart, and
  every verdict is recorded in `latency.log` as `availability_decision` with its
  cause and timing. A coverage test derived from the source tree keeps the next
  tool from reintroducing the shape.
