---
section: Fixed
audience: user
---

- **Opengrep no longer downloads its rules at every start.** It now always loads a local rule file: your repo's own, else a registry pack that a weekly background refresh caches under `~/.pi-lens/rules/`, else a pinned pack that ships with pi-lens. Findings now appear offline and on first run instead of waiting about 8 s for about 1074 downloaded rules (#4765).
