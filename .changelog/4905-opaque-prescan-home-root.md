---
section: Fixed
audience: user
---

- **Tool calls no longer wait on two walks of a non-git home folder (#4905)** — The opaque-mutation prescan and the declaration-file look refuse a session root that is the home folder or above it, and a root already found over the file cap is not walked again in the same session. Each refusal is recorded once per session (`opaque-capture-refused` and `lsp-declaration-look-capped`, subject `home-root`) and reads as unknown, never as "no change".
