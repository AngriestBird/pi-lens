---
section: Changed
audience: internal
---

- **CI enforces the exact `allowScripts` policy and gates the packed tarball under strict npm (refs #1185)** — `npm run check:allow-scripts` fails on an undecided, mismatched, stale or name-only lifecycle-script approval and on a floating direct script-bearing dependency; `@ast-grep/cli` is now pinned exactly and the approvals match the lockfile (`@google/genai`, `protobufjs`, `esbuild`, `fsevents`). CI installs run through the pinned npm with `--strict-allow-scripts`, and a new `npm-strict` install-smoke job installs the packed tarball with no soft allowance. The install selftest now finds the core grammars the tarball ships.
