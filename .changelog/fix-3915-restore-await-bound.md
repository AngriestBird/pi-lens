---
section: Fixed
audience: user
---

- **Bound deferred restore waits (refs #3915)** — The settled drain stops waiting when its restore budget ends or the run is cancelled. The host was already released at the hook wall, so this bound frees the drain's remaining work. Restoration continues, and any lost-edit notice is delivered once when it finishes.
