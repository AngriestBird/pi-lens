---
section: Fixed
audience: user
---

- **Tool calls no longer wait about 2 s in a non-git home folder (#4905)** — The opaque-mutation prescan refuses to walk a session root that is the home folder or above it, and a root already found over the file cap is not walked again in the same session. The call is recorded once as `opaque-capture-refused` and reads as unknown, never as "no change".
