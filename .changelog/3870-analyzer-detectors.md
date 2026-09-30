---
section: Added
---

- **The log analyzer reports the live-session smells (refs #3870)** — `scripts/analyze-pi-lens-logs.mjs` gains the D1-D16 detectors, tightens E1-E5 (LSP path masking, block/warn split, bypassed mismatch, `session_start fired` build attribution, command-path exclusion) and drops the dead `session.rotations` counter and read-guard fields. The analyzer stays read-only and imports no `clients/*.js`.
