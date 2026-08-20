---
section: Fixed
---

- **Biome findings can now reach actionable warnings** — biome's real
  `lint --reporter=json` output (probed live against the shipped 2.5.x
  binary) carries no `tags` field and never did, so the old
  `d.tags?.includes("fixable")` check always missed and every biome
  diagnostic's `fixable`/`autoFixAvailable`/`fixKind` were permanently
  false. The parser now resolves each rule's real fix tier via
  `biome explain <rule>` (the one place biome states fixability as
  structured text, sourced from the running binary's own rule registry),
  cached for the process lifetime since fix tier is a property of the rule,
  not the occurrence. Also aligned the diagnostic location field to biome's
  real `location.path` (the parser and its fixtures assumed
  `location.source`, a field that never shipped) (#1810).
