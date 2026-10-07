---
section: Fixed
audience: user
---

- **A native re-read supersedes a stale bridge read (#3962)** — after a cross-extension read's content changed on disk, a native re-read of the edited lines now clears the read-before-edit block instead of leaving the agent stuck in a re-read loop.
