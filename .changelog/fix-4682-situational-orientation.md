---
section: Fixed
audience: user
---

- **The session-start orientation no longer tells the model to activate tools that are already active.** With `tools.lazy: false`, and under `"auto"` on a model that gets every tool up front, the situational bullet now says to activate through `pi_lens_activate_tools` only for an unlisted tool, so the same text is true under every `tools.lazy` posture (#4682).
