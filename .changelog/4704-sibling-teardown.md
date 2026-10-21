---
section: Fixed
audience: user
---

- **An in-process subagent keeps its project root and language servers when its parent ends first** (#4704): the shared teardown now waits for the last live session in the process, not the last one of the parent's extension activation, and a subagent its runner disposed without a shutdown no longer holds it. A session started or resumed while a subagent runs keeps the language servers that subagent uses instead of restarting them.
