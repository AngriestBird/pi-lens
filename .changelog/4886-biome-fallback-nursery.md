---
section: Fixed
audience: user
---

- **The bundled Biome config loads under Biome 2.6 again (refs #4886)** — In a project with no `biome.json`, pi-lens lints with its own fallback config. That config switched off the nursery rule `useSortedClasses`, which Biome 2.6 renamed, so the managed Biome (which tracks the latest release) rejected the whole file: every Biome lint run reported a config error instead of findings, and `lint --write` fixed nothing. The entry was redundant, since nursery rules are off unless named, so it is gone and the config loads on Biome 2.5 and 2.6 alike.
