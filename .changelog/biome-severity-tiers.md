---
section: Fixed
---

- **Preserve biome's info/hint severity in dispatch** — `biome-check`
  collapsed every non-error biome diagnostic to `warning`, even though
  biome's own JSON declares `information` and `hint` tiers. Biome findings
  now carry the same four-tier `Diagnostic.severity` ast-grep-napi adopted
  in #1787: `information` maps to `info`, `hint` stays `hint`. Only `error`
  still blocks. The on-demand ast-grep CLI path's `formatDiagnostics`
  summary also gained an `info(s)` bucket — an info finding was previously
  counted in the total but named in no tier line.
