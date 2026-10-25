---
section: Fixed
audience: user
---

- **Bound deferred restore waits (refs #3915)** — The settled drain stops waiting when its restore budget ends or the run is cancelled. Restoration continues, and any lost-edit notice is delivered once when it finishes.
