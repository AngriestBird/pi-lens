---
section: Fixed
audience: user
---

- **Tool calls no longer wait on two walks of a non-git home folder (#4905)** — The opaque-mutation prescan refuses a session root that is the home folder or above it, and reads it as unknown, never as "no change". The declaration-file look skips its walk there but still looks for a dependency install, so language servers still restart after one. A root already found over the file cap is not walked again in the same session. Each is recorded once per session (`opaque-capture-refused` and `lsp-declaration-look-capped`, subject `home-root`).
