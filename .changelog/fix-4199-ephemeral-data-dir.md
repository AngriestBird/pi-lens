---
section: Fixed
audience: user
---

- **A project's data directory stays stable for the whole process** (#4199): it is settled when the process first resolves the root, so an ephemeral checkout no longer moves its data when a `.pi-lens` directory appears mid-process, and a `.pi-lens` created by hand in a real project takes effect at the next process start.
