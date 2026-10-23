---
section: Fixed
audience: user
---

- **Opengrep stops downloading its rules at every start once it has them.** A weekly background refresh now fetches the registry rule pack to `~/.pi-lens/rules/`, checks it with `opengrep --validate`, and swaps it in. Sessions use your repo's own rule file if it has one, else that cached pack; until a non-empty pack is cached they fall back to the `auto` download. pi-lens ships no rules (#4765).
