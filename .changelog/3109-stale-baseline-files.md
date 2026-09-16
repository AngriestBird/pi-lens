---
section: Fixed
---

- **Reclaim stale `tmp-hygiene-baseline-<run>.json` files on the existing backstop stale arm (refs #3109, #2912, #3100)** — the #2912 hygiene owner writes one baseline record per run and only ever removed the one it wrote itself, so every owner-less (targeted) run in a persistent dev-box checkout left its own file behind for ever; `removeRunBackstopDirs` now reclaims a `tmp-hygiene-baseline-*` file older than the same six-hour `BACKSTOP_STALE_MS` window it already used for abandoned backstop directories and root-level `orphan-backstop*` residue, leaving the active run's own file untouched until the owner consumes it.
