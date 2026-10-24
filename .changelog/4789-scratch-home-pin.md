---
section: Fixed
audience: internal
---

- **Pin HOME and the XDG dirs in every operator script child (#4789).** `scripts/lib/scratch-home-env.mjs` builds the one home pin (HOME, USERPROFILE, the XDG base dirs, PI_LENS_HOME); release-qa and the eight non-vitest scripts that pinned only PI_LENS_HOME now use it, so no child they spawn reads the real home (#4789).
