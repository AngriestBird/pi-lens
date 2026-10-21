---
section: Fixed
audience: user
---

- **A symlinked file is one file to the read guard and to bash write attribution.** On Linux and macOS, a file read through a symlink and edited through its target (or through a directory link) is no longer refused as never read, and a bash write through a link now reports the blockers the real path reports instead of "clean". Path keys now resolve links the way Windows keys already did. In a project opened through a link, a disposition mark now silences its finding on the next write, and marks an earlier version stored under the link's path are carried over when the session starts (#4689).
