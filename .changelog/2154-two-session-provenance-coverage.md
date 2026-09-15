---
section: Fixed
---

- **Pin diagnostic provenance across two live sessions (refs #2154)** — the real-`pi` harness can now run two children over one project root and one `PI_LENS_HOME`, and a regression test proves a finding one session recorded before a clean change is served by neither session afterwards.
