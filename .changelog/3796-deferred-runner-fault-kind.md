---
section: Fixed
audience: user
---

- **A slow runner that could not parse its tool's output is now reported as a runner failure at turn end (refs #3796)** — The shared parse-error arm (eslint, prisma-validate and others), biome's JSON parse error, cue-vet's unattributable output and gleam's nonzero exit without diagnostics now carry a failure kind (`parser_error` or `unconfirmed_output`), so a deferred run shows "Deferred runner X failed (kind)" beside its synthetic diagnostic instead of passing for a finding. The collect-later `latency.log` row records the kind, and the log analyzer reads it instead of guessing from the diagnostic count.
